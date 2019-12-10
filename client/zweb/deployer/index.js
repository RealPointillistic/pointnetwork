const path = require('path');
const fs = require('fs');
const _ = require('lodash');

class Deployer {
    constructor(ctx) {
        this.ctx = ctx;
        this.cache_uploaded = {};
    }

    async start() {
        // todo
    }

    // todo: beware of infinite recursion!
    async processTemplate(fileName, deployPath) {
        if (fileName in this.cache_uploaded) return this.cache_uploaded[ fileName ];

        console.log('uploading '+fileName+'...');

        const cache_dir = path.join(this.ctx.datadir, 'deployer_cache');

        let tmpTemplate, template;

        if (fileName.split('.').slice(-1)[0] !== "zhtml") {
            // don't parse
            template = fs.readFileSync(fileName, { encoding: null });

            console.log('skipping template parser for', fileName, 'hash', this.ctx.utils.hashFnHex(template));

            tmpTemplate = path.join(cache_dir, this.ctx.utils.hashFnHex(template));
            fs.writeFileSync(tmpTemplate, template, { encoding: null });

        } else {
            console.log('parsing template', fileName);

            // do parse
            template = fs.readFileSync(fileName, 'utf-8');

            /////

            const reg = /{% extends ['"](.*?)['"] %}/g;
            let result;
            while((result = reg.exec(template)) !== null) { // todo: what if it's already a hash?
                const subTemplate = path.join(deployPath, 'views', result[1]);
                if (!fs.existsSync(subTemplate)) throw new Error('Template '+result[1]+' ('+subTemplate+') not found!'); // todo: +stack etc.

                const hash = await this.processTemplate(subTemplate, deployPath); // todo: parallelize // todo: what if already uploaded? use cache
                template = template.replace(result[1], hash); // todo: replace using outer stuff as well
            }

            ///

            // todo: dont parse html with regex!1 you'll go to hell for that! or worse, Turbo Pascal coding bootcamp!
            const regs = [
                /\<link[^\>]*?href=['"](.*?)['"]/g,
                /\<img[^\>]*?src=['"](.*?)['"]/g,
            ];
            for(let reg of regs) {
                while((result = reg.exec(template)) !== null) { // todo: what if it's already a hash? // todo: what if it's https:// or something? // todo: what if it's /_storage/<hash>?
                    const fl = path.join(deployPath, 'views', result[1]);
                    if (!fs.existsSync(fl)) throw new Error('Mentioned file '+result[1]+' ('+fl+') not found!'); // todo: +stack etc. // todo: make it a warning?

                    let ext = /(?:\.([^.]+))?$/.exec(result[1])[1];

                    const hash = await this.processTemplate(fl, deployPath); // todo: parallelize // todo: what if already uploaded? use cache // todo: don't use processTemplate for css files! just upload them, and that's it
                    template = template.replace(result[1], '/_storage/'+hash+'.'+ext); // todo: replace using outer stuff as well
                }
            }

            tmpTemplate = path.join(cache_dir, this.ctx.utils.hashFnHex(template));
            fs.writeFileSync(tmpTemplate, template, 'utf-8');
        }

        const uploaded = await this.ctx.client.storage.putFile(tmpTemplate); // todo: and more options

        this.cache_uploaded[ fileName ] = uploaded.id;

        return uploaded.id;
    }

    async deploy(deployPath) {
        const cache_dir = path.join(this.ctx.datadir, 'deployer_cache');

        // todo: error handling, as usual
        let deployConfigFilePath = path.join(deployPath, 'point.deploy.json');
        let deployConfigFile = fs.readFileSync(deployConfigFilePath, 'utf-8');
        let deployConfig = JSON.parse(deployConfigFile);

        // assert(deployConfig.version === 1); // todo: msg

        let target = deployConfig.target;

        // Deploy contracts
        let contractNames = deployConfig.contracts;
        if (!contractNames) contractNames = [];
        for(let contractName of contractNames) {
            let fileName = path.join(deployPath, 'contracts', contractName+'.sol');
            await this.deployContract(target, contractName, fileName);
        }

        let routesFilePath = path.join(deployPath, 'routes.json');
        let routesFile = fs.readFileSync(routesFilePath, 'utf-8');
        let routes = JSON.parse(routesFile);

        //let uploadFiles
        //let parseFiles = // todo: should be queue

        for (let k in routes) {
            if (routes.hasOwnProperty(k)) {
                let v = routes[k];

                let templateFileName = path.join(deployPath, 'views', v);

                const hash = await this.processTemplate(templateFileName, deployPath);
                routes[k] = hash;
            }
        }

        console.log('uploading route file...');
        this.ctx.utils.makeSurePathExists(cache_dir);
        const tmpRoutesFilePath = path.join(cache_dir, this.ctx.utils.hashFnHex(JSON.stringify(routes)));
        fs.writeFileSync(tmpRoutesFilePath, JSON.stringify(routes));
        let routeFileUploaded = await this.ctx.client.storage.putFile(tmpRoutesFilePath); // todo: and more options

        await this.updateZDNS(target, routeFileUploaded.id);

        await this.updateKeyValue(target, deployConfig.keyvalue);

        console.log('Deploy finished');
    }

    async deployContract(target, contractName, fileName) {
        const path = require('path');
        const solc = require('solc');
        const fs = require('fs-extra');

        const cache_dir = path.join(this.ctx.datadir, 'deployer_cache');
        this.ctx.utils.makeSurePathExists(cache_dir);
        const buildPath = path.resolve(cache_dir, 'build');
        fs.removeSync(buildPath);

        const compileConfig = {
            language: 'Solidity',
            sources: {
                [contractName+'.sol']: {
                    content: fs.readFileSync(fileName, 'utf8')
                },
            },
            settings: {
                outputSelection: { // return everything
                    '*': {
                        '*': ['*']
                    }
                }
            }
        };

        let getImports = function(dependency) {
            switch (dependency) {
                case contractName+'.sol':
                    return {contents: fs.readFileSync(fileName, 'utf8')};
                default:
                    return {error: 'File not found'}
            }
        };

        let compiledSources = JSON.parse(solc.compile(JSON.stringify(compileConfig), getImports));

        if (!compiledSources) {
            throw new Error(">>>>>>>>>>>>>>>>>>>>>>>> SOLIDITY COMPILATION ERRORS <<<<<<<<<<<<<<<<<<<<<<<<\nNO OUTPUT");
        } else if (compiledSources.errors) {
            let found = false;
            let msg = '';
            for(let e of compiledSources.errors) {
                if (e.severity === 'warning') {
                    console.warn(e);
                    continue;
                }
                found = true;
                msg += error.formattedMessage + "\n"
            }
            msg = ">>>>>>>>>>>>>>>>>>>>>>>> SOLIDITY COMPILATION ERRORS <<<<<<<<<<<<<<<<<<<<<<<<\n" + msg;
            if (found) throw new Error(msg);
        }

        let artifacts;
        for (let contractFileName in compiledSources.contracts) {
            const _contractName = contractFileName.replace('.sol', '');
            artifacts = compiledSources.contracts[contractFileName][_contractName];
        }

        const truffleContract = require('@truffle/contract');
        const contract = truffleContract(artifacts);
        contract.setProvider(this.ctx.web3.currentProvider);

        let gasPrice = await this.ctx.web3.eth.getGasPrice();
        let deployedContractInstance = await contract.new({ from: this.ctx.web3.eth.defaultAccount, gasPrice, gas: 700000 }); // todo: magic number
        let address = deployedContractInstance.address;

        console.log('Deployed Contract Instance of '+contractName, address);

        const artifactsJSON = JSON.stringify(artifacts);
        const tmpFilePath = path.join(cache_dir, this.ctx.utils.hashFnHex(artifactsJSON));
        fs.writeFileSync(tmpFilePath, artifactsJSON);
        let artifacts_storage_id = (await this.ctx.client.storage.putFile(tmpFilePath)).id;

        await this.ctx.web3bridge.putKeyValue(target, 'zweb/contracts/address/'+contractName, address);
        await this.ctx.web3bridge.putKeyValue(target, 'zweb/contracts/abi/'+contractName, artifacts_storage_id);

        console.log('Contract '+contractName+' deployed');
    };

    async updateZDNS(host, id) {
        let target = host.replace('.z', '');
        console.log('Updating ZDNS', {target, id});
        await this.ctx.web3bridge.putZRecord(target, '0x'+id);
    }

    async updateKeyValue(target, values) {
        for(let key in values) {
            let value = Object.assign({}, values[key]);
            for(let k in value) {
                let v = value[k];
                if (_.startsWith(k, '__')) {
                    console.log('uploading keyvalue from config', key, k);
                    const cache_dir = path.join(this.ctx.datadir, 'deployer_cache');
                    this.ctx.utils.makeSurePathExists(cache_dir);
                    const tmpFilePath = path.join(cache_dir, this.ctx.utils.hashFnHex(v));
                    fs.writeFileSync(tmpFilePath, v);
                    let uploaded = await this.ctx.client.storage.putFile(tmpFilePath); // todo: and more options

                    delete value[k];
                    value[k.replace('__', '')] = uploaded.id;
                }
            }
            console.log(value);
            await this.ctx.web3bridge.putKeyValue(target, key, JSON.stringify(value));
        }
    }
}

module.exports = Deployer;