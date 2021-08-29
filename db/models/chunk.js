const crypto = require('crypto');
const Model = require('../model');
const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
let StorageLink;
let File;
let FileMap;

class Chunk extends Model {
    constructor(...args) {
        super(...args);

        // This is to avoid circular dependencies:
        File = require('./file');
        StorageLink = require('./storage_link');
        FileMap = require('./file_map');
    }

    getData() {
        // todo: read from fs if you have it already or retrieve using storage layer client
        return fs.readFileSync(Chunk.getChunkStoragePath(this.id), { encoding: null });
    }

    setData(rawData) {
        if (!Buffer.isBuffer(rawData)) throw Error('Chunk.setData: rawData must be a Buffer');
        let hash = this.ctx.utils.hashFnHex(rawData);

        if (this.id) {
            if (this.id !== hash) {
                // console.debug(rawData.toString());
                console.debug({rawDataHex: rawData.toString('hex'), rawData: rawData.toString(), hash, id: this.id}); // todo: remove at least .toString() parts for prod
                throw Error('Chunk ID and data hash don\'t match');
            }
        } else {
            this.id = hash;
        }

        this.dl_status = Chunk.DOWNLOADING_STATUS_DOWNLOADED;
        this.size = rawData.size;

        Chunk.forceSaveToDisk(rawData, this.id);
    }

    getSize() {
        if (typeof this.size !== 'undefined') {
            return this.size;
        } else {
            const filePath = Chunk.getChunkStoragePath(this.id);
            if (!fs.existsSync(filePath)) return undefined;
            return fs.statSync(filePath).size;
        }
    }

    static async findOrCreateByData(rawData) {
        if (!Buffer.isBuffer(rawData)) throw Error('Chunk.findOrCreateByData: rawData must be a Buffer');

        let id = this.ctx.utils.hashFnHex(rawData);
        let result = await this.find(id);
        if (result === null) {
            result = this.build();
            this.id = id;
        }

        result.setData(rawData);

        return result;
    }

    isUploading() {
        return this.ul_status === Chunk.UPLOADING_STATUS_UPLOADING;
    }
    isDownloading() {
        return this.dl_status === Chunk.DOWNLOADING_STATUS_DOWNLOADING;
    }

    async reconsiderUploadingStatus(cascade = true) {
        let fn = async() => {
            const live_copies = await StorageLink.byChunkIdAndStatus(this.id, StorageLink.STATUS_SIGNED);

            // 1. Redundancy
            if (live_copies.length < this.redundancy) {
                return await this.changeULStatus(Chunk.UPLOADING_STATUS_UPLOADING);
            }

            // 2. Expiry
            for(let l of live_copies) {
                if (l.expires < this.expires) { // todo: have some leeway in here, to avoid triggering reupload each time without it being necessary?
                    return await this.changeULStatus(Chunk.UPLOADING_STATUS_UPLOADING);
                }
            }

            // 3. Autorenew
            // todo, and not only here

            // Otherwise consider it live
            await this.changeULStatus(Chunk.UPLOADING_STATUS_UPLOADED);
        };
        let result = await fn();

        await this.refresh();

        if (cascade) {
            for(let f of await this.getFiles()) {
                await f.reconsiderUploadingStatus(false);
            }
        }

        return result;

        // todo: maybe immediately start uploading here? trigger the tick()? but be careful with recursion loops
    }

    async getLinksWithStatus(status) {
        return await StorageLink.byChunkIdAndStatus(this.id, status);
    }

    async reconsiderDownloadingStatus(cascade = true) {
        // todo todo todo

        // Otherwise consider it live
        // await this.changeDLStatus(Chunk.DOWNLOADING_STATUS_DOWNLOADED);

        // todo: at least prefix it with IF chunk.dl_status === Chunk.DOWNLOADING_STATUS_DOWNLOADED then reconsider

        if (cascade) {
            for(let f of await this.getFiles()) {
                await f.reconsiderDownloadingStatus(false);
            }
        }

        // todo: immediately start downloading here? trigger the tick()?
    }

    async getFiles() {
        if (! ('belongsToFiles' in this._attributes)) return [];
        const file_ids = this.belongsToFiles.map(x => x[0]);
        let results = await Promise.all(file_ids.map(async(id) => await File.findOrFail(id)));
        return results;
    }

    async changeULStatus(status) {
        if (this.ul_status === status) return;
        this.ul_status = status;
        await this.save();
    }
    async changeDLStatus(status) {
        if (this.dl_status === status) return;
        this.dl_status = status;
        await this.save();
    }

    // This fn doesn't save!
    async addBelongsToFile(file, offset) {
        const filemap = FileMap.build();
        filemap.file_id = file.id; // todo: make sure file.id is not empty
        filemap.chunk_id = this.id;
        filemap.chunk_index = offset;
        await filemap.save();
    }

    getStorageLinks() {
        const target = {};
        return new Proxy(target, {
            get: async(x, status) => {
                const allStatuses = StorageLink.allStatuses();
                if (status === 'constructor') return target;
                if (! allStatuses.includes(status) && status !== 'all') return void 0;
                if (status === 'all') {
                    let results = await Promise.all(allStatuses.map(async(s) => await this.getStorageLinks()[s]));
                    return this.ctx.utils.iterableFlat(results);
                }
                return await StorageLink.byChunkIdAndStatus(this.id, status);
            },
            set: async(x, status, value) => {
                // todo
            }
        });
    }

    // todo: delete
    // async getStorageLinkIds(status = null) {
    //     if (! status) status = Chunk.STORAGE_LINK_STATUS_ALL;
    //     if (! this.storage_link_ids) return [];
    //     if (! this.storage_link_ids[status]) return [];
    //     if (status === Chunk.STORAGE_LINK_STATUS_ALL) {
    //         return (await Promise.all(Chunk.STORAGE_LINK_STATUSES.map(async(status) => await this.getStorageLinkIds(status)))).flat();
    //     }
    //     return this.storage_link_ids[status];
    // }

    static getChunkStoragePath(id) {
        const cache_dir = path.join(this.ctx.datadir, this.ctx.config.client.storage.cache_path);
        this.ctx.utils.makeSurePathExists(cache_dir);
        return path.join(cache_dir, 'chunk_' + id);
    }

    static forceSaveToDisk(data, id = null) {
        if (!Buffer.isBuffer(data)) throw Error('Chunk.forceSaveToDisk: data must be a Buffer');

        if (id === null) id = this.ctx.utils.hashFnHex(data);

        // todo: dont zero out the rest of the chunk if it's the last one, save space

        // todo: what if already exists? should we overwrite again or just use it? without integrity check?
        const chunk_file_path = Chunk.getChunkStoragePath(id);
        if (! fs.existsSync(chunk_file_path)) {
            fs.writeFileSync(chunk_file_path, data, { encoding: null });
        }

        return id;
    }

}

Chunk.init({
    id: { type: Sequelize.DataTypes.STRING, unique: true, primaryKey: true },
    size: { type: Sequelize.DataTypes.INTEGER },

    ul_status: { type: Sequelize.DataTypes.STRING },
    dl_status: { type: Sequelize.DataTypes.STRING },

    redundancy: { type: Sequelize.DataTypes.INTEGER },
    expires: { type: Sequelize.DataTypes.BIGINT },
    autorenew: { type: Sequelize.DataTypes.BOOLEAN },
}, {
    indexes: [
        { fields: ['ul_status'] },
        { fields: ['dl_status'] },
    ]
});

// Chunk.belongsTo(File, { foreignKey: 'fileId' });

Chunk.UPLOADING_STATUS_CREATED = 'us0';
Chunk.UPLOADING_STATUS_UPLOADING = 'us1';
Chunk.UPLOADING_STATUS_UPLOADED = 'us99';
Chunk.DOWNLOADING_STATUS_CREATED = 'ds0';
Chunk.DOWNLOADING_STATUS_DOWNLOADING = 'ds1';
Chunk.DOWNLOADING_STATUS_DOWNLOADED = 'ds99';
Chunk.DOWNLOADING_STATUS_FAILED = 'ds2';

module.exports = Chunk;
