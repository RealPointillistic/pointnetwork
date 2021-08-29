const PointSDKController = require('./PointSDKController')
const File = require('../../db/models/file');
const Chunk = require('../../db/models/chunk');
const DEFAULT_ENCODING = 'utf-8'

class StorageController extends PointSDKController {
  constructor(ctx, req) {
    super(ctx)

    throw Error("StorageController module is out of date! You need to sequelize it!");

    this.req = req
  }

  // Returns all file metadata stored in the nodes leveldb
  async files() {
    const allUploadedFiles = await File.allBy('ul_status', File.UPLOADING_STATUS_UPLOADED)
    const allDownloadedFiles = await File.allBy('dl_status', File.DOWNLOADING_STATUS_DOWNLOADED)
    // union all uploaded and downloaded files to a unique list
    var allFiles = [...new Set([...allUploadedFiles, ...allDownloadedFiles])];
    // return a subset of the attributes to the client
    const files = allFiles.map((file) =>
      (({ id, originalPath, size, redundancy, expires, autorenew, chunkIds, ul_status }) => ({ id, originalPath, size, redundancy, expires, autorenew, chunkCount: chunkIds.length, ul_status }))(file))

    return this._response(files);
  }

  // Returns a single file metadata stored in the nodes leveldb
  async fileById() {
    const id = this.req.params.id;
    const file = await File.findOrFail(id);
    return this._response(file);
  }

  // Returns all chunk metadata stored in the nodes leveldb
  async chunks() {
    const allUploadedChunks = await Chunk.allBy('ul_status', Chunk.UPLOADING_STATUS_UPLOADED)
    // union all uploaded and downloaded chunks to a unique list
    var allChunks = allUploadedChunks
    // return a subset of the attributes to the client
    const chunks = allChunks.map((chunk) =>
      (({ id, redundancy, expires, autorenew, length, ul_status, dl_status }) => ({ id, redundancy, expires, autorenew, length, ul_status, dl_status }))(chunk))

    return this._response(chunks)
  }

  // Returns a single chunk metadata stored in the nodes leveldb
  async chunkById() {
    const id = this.req.params.id
    const chunk = await Chunk.findOrFail(id)
    return this._response(chunk)
  }

  // similar to `storage_get` Twig function - gets a files contents from storage by its CID
  async get() {
    const cid = this.req.params.id;
    const encoding = this.req.query.encoding ? this.req.query.encoding : DEFAULT_ENCODING;

    const contents = await this.ctx.client.storage.readFile(cid, encoding);
    return this._response(contents)
  }
}

module.exports = StorageController
