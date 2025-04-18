/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 *
 * Originally from:
 * https://github.com/zhukov/webogram
 * Copyright (C) 2014 Igor Zhukov <igor.beatle@gmail.com>
 * https://github.com/zhukov/webogram/blob/master/LICENSE
 */

import type {ThumbCache} from '../storages/thumbs';
import {Document, DocumentAttribute, PhotoSize, WallPaper} from '../../layer';
import {ReferenceContext} from '../mtproto/referenceDatabase';
import {getFullDate} from '../../helpers/date/getFullDate';
import isObject from '../../helpers/object/isObject';
import safeReplaceArrayInObject from '../../helpers/object/safeReplaceArrayInObject';
import {AppManager} from './manager';
import wrapPlainText from '../richTextProcessor/wrapPlainText';
import assumeType from '../../helpers/assumeType';
import {getEnvironment} from '../../environment/utils';
import MTProtoMessagePort from '../mtproto/mtprotoMessagePort';
import getDocumentInputFileLocation from './utils/docs/getDocumentInputFileLocation';
import getDocumentURL from './utils/docs/getDocumentURL';
import makeError from '../../helpers/makeError';
import {EXTENSION_MIME_TYPE_MAP} from '../../environment/mimeTypeMap';
import {THUMB_TYPE_FULL} from '../mtproto/mtproto_config';
import tsNow from '../../helpers/tsNow';
import appManagersManager from './appManagersManager';
import tryPatchMp4 from '../../helpers/fixChromiumMp4';

export type MyDocument = Document.document;

// TODO: если залить картинку файлом, а потом перезайти в диалог - превьюшка заново скачается

type WallPaperId = WallPaper.wallPaper['id'];

let uploadWallPaperTempId = 0;

export class AppDocsManager extends AppManager {
  private docs: {
    [docId: DocId]: MyDocument
  };

  private uploadingWallPapers: {
    [id: WallPaperId]: {
      cacheContext: ThumbCache,
      file: File
    }
  };

  private fixingChromiumMp4: {[src: string]: MaybePromise<string>};

  private requestingDocParts: {[docId: DocId]: Set<() => void>};

  public altDocsByMainMediaDocument: {[docId: DocId]: Document.document[]};

  protected after() {
    this.docs = {};
    this.uploadingWallPapers = {};
    this.fixingChromiumMp4 = {};
    this.requestingDocParts = {};
    this.altDocsByMainMediaDocument = {};

    MTProtoMessagePort.getInstance<false>().addEventListener('serviceWorkerOnline', (online) => {
      if(!online) {
        this.onServiceWorkerFail();
      }
    });
  }

  private onServiceWorkerFail = () => {
    for(const id in this.docs) {
      const doc = this.docs[id];

      if(doc.supportsStreaming) {
        delete doc.supportsStreaming;
        this.thumbsStorage.deleteCacheContext(doc);
      }
    }
  };

  public saveDoc(doc: Document, context?: ReferenceContext, altDocuments?: Document[]): MyDocument {
    if(!doc || doc._ === 'documentEmpty') {
      return;
    }

    // * force it to be string everywhere, at least for HLS streaming
    doc.id = doc.id.toString();

    if(altDocuments) {
      const saved = altDocuments.map((altDoc) => this.saveDoc(altDoc, context)).filter(Boolean);
      this.altDocsByMainMediaDocument[doc.id] = saved;
      altDocuments.splice(0, altDocuments.length, ...saved);
    }

    const oldDoc = this.docs[doc.id];

    if(doc.file_reference) { // * because we can have a new object w/o the file_reference while sending
      safeReplaceArrayInObject('file_reference', oldDoc, doc);
      this.referenceDatabase.saveContext(doc.file_reference, context);
    }

    // console.log('saveDoc', apiDoc, this.docs[apiDoc.id]);
    // if(oldDoc) {
    //   //if(doc._ !== 'documentEmpty' && doc._ === d._) {
    //     if(doc.thumbs) {
    //       if(!oldDoc.thumbs) oldDoc.thumbs = doc.thumbs;
    //       /* else if(apiDoc.thumbs[0].bytes && !d.thumbs[0].bytes) {
    //         d.thumbs.unshift(apiDoc.thumbs[0]);
    //       } else if(d.thumbs[0].url) { // fix for converted thumb in safari
    //         apiDoc.thumbs[0] = d.thumbs[0];
    //       } */
    //     }

    //   //}

    //   return oldDoc;

    //   //return Object.assign(d, apiDoc, context);
    //   //return context ? Object.assign(d, context) : d;
    // }

    if(!oldDoc) {
      this.docs[doc.id] = doc;
    }

    // * exclude from state
    // defineNotNumerableProperties(doc, [/* 'thumbs',  */'type', 'h', 'w', 'file_name',
    // 'file', 'duration', 'downloaded', 'url', 'audioTitle',
    // 'audioPerformer', 'sticker', 'stickerEmoji', 'stickerEmojiRaw',
    // 'stickerSetInput', 'stickerThumbConverted', 'animated', 'supportsStreaming']);

    for(let i = 0, length = doc.attributes.length; i < length; ++i) {
      const attribute = doc.attributes[i];
      switch(attribute._) {
        case 'documentAttributeFilename': {
          doc.file_name = wrapPlainText(attribute.file_name);
          break;
        }

        case 'documentAttributeAudio': {
          if(doc.type === 'round') {
            break;
          }

          doc.duration = attribute.duration;
          doc.type = attribute.pFlags.voice && doc.mime_type === EXTENSION_MIME_TYPE_MAP.ogg ? 'voice' : 'audio';
          break;
        }

        case 'documentAttributeVideo': {
          doc.duration = attribute.duration;
          doc.w = attribute.w;
          doc.h = attribute.h;
          // apiDoc.supportsStreaming = attribute.pFlags?.supports_streaming/*  && apiDoc.size > 524288 */;
          if(/* apiDoc.thumbs &&  */attribute.pFlags.round_message) {
            doc.type = 'round';
          } else /* if(apiDoc.thumbs) */ {
            doc.type = 'video';
          }
          break;
        }

        case 'documentAttributeCustomEmoji':
        case 'documentAttributeSticker': {
          if(attribute.alt !== undefined) {
            doc.stickerEmojiRaw = attribute.alt;
          }

          if(attribute.stickerset) {
            if(attribute.stickerset._ === 'inputStickerSetEmpty') {
              delete attribute.stickerset;
            } else if(attribute.stickerset._ === 'inputStickerSetID') {
              doc.stickerSetInput = attribute.stickerset;
            }
          }

          // * there can be no thumbs, then it is a document
          if(/* apiDoc.thumbs &&  */doc.mime_type === EXTENSION_MIME_TYPE_MAP.webp && (doc.thumbs || getEnvironment().IS_WEBP_SUPPORTED)) {
            doc.type = 'sticker';
            doc.sticker = 1;
          } else if(doc.mime_type === EXTENSION_MIME_TYPE_MAP.webm) {
            // if(!getEnvironment().IS_WEBM_SUPPORTED) {
            //   break;
            // }

            doc.type = 'sticker';
            doc.sticker = 3;
            doc.animated = true;
          }
          break;
        }

        case 'documentAttributeImageSize': {
          doc.type = 'photo';
          doc.w = attribute.w;
          doc.h = attribute.h;
          break;
        }

        case 'documentAttributeAnimated': {
          if((doc.mime_type === EXTENSION_MIME_TYPE_MAP.gif || doc.mime_type === EXTENSION_MIME_TYPE_MAP.mp4)/*  && apiDoc.thumbs */) {
            doc.type = 'gif';
          }

          doc.animated = true;
          break;
        }
      }
    }

    if(!doc.mime_type) {
      const ext = (doc.file_name || '').split('.').pop();
      const mappedMimeType = ext && EXTENSION_MIME_TYPE_MAP[ext.toLowerCase() as any as MTFileExtension];
      if(mappedMimeType) {
        doc.mime_type = mappedMimeType;
      } else {
        switch(doc.type) {
          case 'gif':
          case 'video':
          case 'round':
            doc.mime_type = EXTENSION_MIME_TYPE_MAP.mp4;
            break;
          case 'sticker':
            doc.mime_type = EXTENSION_MIME_TYPE_MAP.webp;
            break;
          case 'audio':
            doc.mime_type = EXTENSION_MIME_TYPE_MAP.mp3;
            break;
          case 'voice':
            doc.mime_type = EXTENSION_MIME_TYPE_MAP.ogg;
            break;
          default:
            doc.mime_type = 'application/octet-stream';
            break;
        }
      }
    } else if(doc.mime_type === EXTENSION_MIME_TYPE_MAP.pdf) {
      doc.type = 'pdf';
    } else if(doc.mime_type === EXTENSION_MIME_TYPE_MAP.gif) {
      doc.type = 'gif';
    } else if(doc.mime_type === EXTENSION_MIME_TYPE_MAP.tgs && doc.file_name === 'AnimatedSticker.tgs') {
      doc.type = 'sticker';
      doc.animated = true;
      doc.sticker = 2;
    }

    if(doc.type === 'voice' || doc.type === 'round') {
      // browser will identify extension
      const attribute = doc.attributes.find((attribute) => attribute._ === 'documentAttributeFilename') as DocumentAttribute.documentAttributeFilename;
      const ext = attribute && attribute.file_name.split('.').pop();
      const date = getFullDate(new Date(doc.date * 1000), {monthAsNumber: true, leadingZero: true}).replace(/[:\.]/g, '-').replace(', ', '_');
      doc.file_name = `${doc.type}_${date}${ext ? '.' + ext : ''}`;
    }

    if(
      appManagersManager.isServiceWorkerOnline &&
      (
        (doc.type === 'gif' && doc.size > 8e6) ||
        doc.type === 'audio' ||
        doc.type === 'video'
      )/*  || doc.mime_type.indexOf('video/') === 0 */
    ) {
      doc.supportsStreaming = true;

      const cacheContext = this.thumbsStorage.getCacheContext(doc);
      // const supportsHlsStreaming = (altDocuments || []).some((doc) => isDocumentHlsQualityFile(doc));

      /**
       * Need to override when supportsHlsStreaming=true as for some reason the message.media
       * comes first without alt_documents, and later comes with them
       */
      if(!cacheContext.url/*  || supportsHlsStreaming */) {
        this.thumbsStorage.setCacheContextURL(doc, undefined, getDocumentURL(doc/* , {supportsHlsStreaming} */), 0);
      }
    } else {
      doc.supportsStreaming = false;
    }

    // for testing purposes
    // doc.supportsStreaming = false;
    // doc.url = ''; // * this will break upload urls

    doc.file_name ||= '';

    /* if(!doc.url) {
      doc.url = this.getFileURL(doc);
    } */

    if(oldDoc) {
      return Object.assign(oldDoc, doc);
    }

    return doc;
  }

  public getDoc(docId: DocId | MyDocument): MyDocument {
    return isObject<MyDocument>(docId) ? docId : this.docs[docId];
  }

  public downloadDoc(doc: MyDocument, queueId?: number, onlyCache?: boolean) {
    return this.apiFileManager.downloadMedia({
      media: doc,
      queueId,
      onlyCache
    });
  }

  public saveWebPConvertedStrippedThumb(docId: DocId, bytes: Uint8Array) {
    const doc = this.getDoc(docId);
    if(!doc) {
      return;
    }

    const thumb = doc.thumbs && doc.thumbs.find((thumb) => thumb._ === 'photoStrippedSize') as PhotoSize.photoStrippedSize;
    if(!thumb) {
      return;
    }

    doc.pFlags.stickerThumbConverted = true;
    thumb.bytes = bytes;
  }

  public prepareWallPaperUpload(file: File) {
    const id = 'wallpaper-upload-' + ++uploadWallPaperTempId;

    const thumb = {
      _: 'photoSize',
      h: 0,
      w: 0,
      location: {} as any,
      size: file.size,
      type: THUMB_TYPE_FULL
    } as PhotoSize.photoSize;
    let document: MyDocument = {
      _: 'document',
      access_hash: '',
      attributes: [],
      dc_id: 0,
      file_reference: [],
      id,
      mime_type: file.type as MTMimeType,
      size: file.size,
      date: tsNow(true),
      pFlags: {},
      thumbs: [thumb],
      file_name: file.name
    };

    document = this.saveDoc(document);

    const cacheContext = this.thumbsStorage.setCacheContextURL(document, undefined, URL.createObjectURL(file), file.size);

    const wallpaper: WallPaper.wallPaper = {
      _: 'wallPaper',
      access_hash: '',
      document: document,
      id,
      slug: id,
      pFlags: {}
    };

    this.uploadingWallPapers[id] = {
      cacheContext,
      file
    };

    return wallpaper;
  }

  public uploadWallPaper(id: WallPaperId) {
    const {cacheContext, file} = this.uploadingWallPapers[id];
    delete this.uploadingWallPapers[id];

    const upload = this.apiFileManager.upload({file, fileName: file.name});
    return upload.then((inputFile) => {
      return this.apiManager.invokeApi('account.uploadWallPaper', {
        file: inputFile,
        mime_type: file.type,
        settings: {
          _: 'wallPaperSettings',
          pFlags: {}
        }
      }).then((wallPaper) => {
        assumeType<WallPaper.wallPaper>(wallPaper);
        wallPaper.document = this.saveDoc(wallPaper.document);
        this.thumbsStorage.setCacheContextURL(wallPaper.document, undefined, cacheContext.url, cacheContext.downloaded);

        return wallPaper;
      });
    });
  }

  public requestDocPart(docId: DocId, dcId: number, offset: number, limit: number) {
    const doc = this.getDoc(docId);
    if(!doc) return Promise.reject(makeError('NO_DOC'));

    const set = this.requestingDocParts[docId] ??= new Set();

    const onFinish = () => {
      if(
        set.delete(cancel) &&
        !set.size &&
        this.requestingDocParts[docId] === set
      ) {
        delete this.requestingDocParts[docId];
      }
    };

    let canceled = false;
    const cancel = () => {
      canceled = true;
      onFinish();
    };

    set.add(cancel);

    const promise = this.apiFileManager.requestFilePart({
      dcId,
      location: getDocumentInputFileLocation(doc),
      offset,
      limit,
      checkCancel: () => {
        if(canceled) {
          throw makeError('DOWNLOAD_CANCELED');
        }
      }
    });

    promise.finally(onFinish);

    return promise;
  }

  public cancelDocPartsRequests(docId: DocId) {
    const set = this.requestingDocParts[docId];
    if(!set) return;

    for(const cancel of set) {
      cancel();
    }
  }

  public fixChromiumMp4(src: string) {
    return this.fixingChromiumMp4[src] ??= fetch(src)
    .then((response) => response.arrayBuffer())
    .then((ab) => {
      const u8 = new Uint8Array(ab);
      tryPatchMp4(u8);
      return this.fixingChromiumMp4[src] = URL.createObjectURL(new Blob([u8]));
    });
  }

  public getAltDocsByDocument(docId: DocId) {
    return this.altDocsByMainMediaDocument[docId];
  }
}
