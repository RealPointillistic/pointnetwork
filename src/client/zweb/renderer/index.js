const TwigLib = require('twig');
const _ = require('lodash');
const {promises: fs} = require('fs');
const {encryptData, decryptData} = require('../../encryptIdentityUtils');
const {getFile, getJSON, getFileIdByPath, uploadFile} = require('../../storage');
const config = require('config');
const logger = require('../../../core/log');
const {getNetworkPrivateKey, getNetworkAddress} = require('../../../wallet/keystore');
const log = logger.child({module: 'Renderer'});
const blockchain = require('../../../network/providers/ethereum');
const {readFileByPath, getSecretToken} = require('../../../util');
const keyValue = require('../../../network/keyvalue');
//get the object that stores the csrf tokens.
const {default: csrfTokens} = require('./csrfTokens');
const {sign} = require('jsonwebtoken');

// todo: maybe use twing nodule instead? https://github.com/ericmorand/twing

const mode = config.has('mode') && config.get('mode');
const sdkFile = config.has('sdk_file') && config.get('sdk_file');

const generateJwt = async () =>
    sign({payload: 'point_token'}, await getSecretToken(), {expiresIn: '1h'});

class Renderer {
    #twigs = {};
    #twigs_use_counter = {};

    constructor({rootDirId, localDir}) {
        this.config = config.get('zproxy');
        this.rootDirId = rootDirId;
        this.localDir = localDir;
    }

    async render(template_id, template_contents, host, request_params = {}) {
        try {
            const Twig = this.#getTwigForHost(host);

            const template = Twig.twig({
                id: host + '/' + template_id,
                allowInlineIncludes: true,
                autoescape: true,
                strict_variables: true,
                data: template_contents,
                async: true, // todo
                rethrow: true // makes twig stop and dump full message to us, and from us into the browser instead of just logging it into the console
            });

            // Here we can specify global variables to pass into twig
            let variables = {host};
            variables = Object.assign({}, variables, {request: request_params});

            const result = await template.renderAsync(variables);

            // Okay, we shouldn't be nuking our Twig cache each time, but I figured it's better if we suffer on performance a bit,
            // than have a memory leak with thousands of Twig objects in memory waiting
            this.#removeTwigForHost(host);

            let render = result.toString();

            if (mode === 'gateway' && sdkFile) {
                log.debug({sdkFile}, 'Entering gateway mode');
                const sdk = await fs.readFile(sdkFile, {encoding: 'utf-8'});
                if (sdk) {
                    const tokenScipt = `<script>
                        window.IS_GATEWAY = true;
                        window.POINT_JWT = "${await generateJwt()}";
                    </script>`;
                    const sdkScript = `<script defer>${sdk}</script>`;
                    if (render.indexOf('</head>')) {
                        log.debug('Replacing <head>');
                        render = render.replace('</head>', `${tokenScipt}${sdkScript}</head>`);
                    } else if (render.indexOf('</body>')) {
                        log.debug('Replacing <body>');
                        render = render.replace('<body>', `<body>${tokenScipt}${sdkScript}`);
                    } else {
                        log.warn('Neither head not body found, appending script to the page');
                        render += sdkScript;
                    }
                }
            }

            return render;
        } catch (e) {
            this.#removeTwigForHost(host);
            throw e;
        }
    }

    #defineAvailableFunctions() {
        // These functions will be available for zApps to call in ZHTML
        return {
            keyvalue_list: async function(host, key) {
                return keyValue.list(host, key);
            },
            keyvalue_get: async function(host, key) {
                return keyValue.get(host, key);
            },
            storage_get_by_ikv: async function(identity, key) {
                try {
                    const fileKey = await blockchain.getKeyValue(identity, key);
                    return await getFile(fileKey);
                } catch (e) {
                    log.error({identity, key, ...e}, 'storage_get_by_ikv error');
                    return 'Invalid Content';
                }
            },
            storage_get: async function(key) {
                try {
                    return await getFile(key);
                } catch (e) {
                    return 'Invalid Content';
                }
            },
            storage_get_parsed: async function(key) {
                return await getJSON(key);
            },
            storage_put: async function(content) {
                return uploadFile(content);
            },
            encrypt_data: async function(publicKey, data) {
                const host = this.host;
                return await encryptData(host, data, publicKey); // todo: make sure you're not encrypting on something stupid like 0x0 public key
            },
            decrypt_data: async function(encryptedData, unparsedEncryptedSymmetricObjJSON) {
                const host = this.host;
                const privateKey = getNetworkPrivateKey();

                const encryptedSymmetricObjJS = JSON.parse(unparsedEncryptedSymmetricObjJSON);
                const encryptedSymmetricObj = {};
                for (const k in encryptedSymmetricObjJS) {
                    encryptedSymmetricObj[k] = Buffer.from(encryptedSymmetricObjJS[k], 'hex');
                }
                const decryptedData = await decryptData(
                    host,
                    Buffer.from(encryptedData, 'hex'),
                    encryptedSymmetricObj,
                    privateKey
                );
                return decryptedData.plaintext.toString();
            },
            isHash: async function(str) {
                const s = _.startsWith(str, '0x') ? str.substr(2) : str;
                if (s.length !== 64) return false;
                return new RegExp('^[0-9a-fA-F]+$').test(s);
            },
            identity_by_owner: async function(owner) {
                return await blockchain.identityByOwner(owner);
            },
            owner_by_identity: async function(identity) {
                return await blockchain.ownerByIdentity(identity);
            },
            public_key_by_identity: async function(identity) {
                return await blockchain.commPublicKeyByIdentity(identity);
            },
            identity_ikv_get: async function(identity, key) {
                return await blockchain.getKeyValue(identity, key);
            },
            contract_get: async function(target, contractName, method, params) {
                return await blockchain.callContract(target, contractName, method, params);
            },
            contract_call: async function(
                host,
                contractName,
                methodName,
                params,
                version = 'latest'
            ) {
                return await blockchain.sendToContract(
                    host.replace(/\.point$/, ''),
                    contractName,
                    methodName,
                    params,
                    {},
                    version
                );
            },
            contract_events: async function(host, contractName, event, filter = {}) {
                //delete keys property inserted by twig
                if (filter.hasOwnProperty('_keys')) delete filter['_keys'];
                const options = {filter: filter, fromBlock: 0, toBlock: 'latest'};
                const events = await blockchain.getPastEvents(
                    host.replace(/\.point$/, ''),
                    contractName,
                    event,
                    options
                );
                const eventData = [];
                for (const ev of events) {
                    //console.log(ev, ev.raw);
                    const eventTimestamp = await blockchain.getBlockTimestamp(ev.blockNumber);
                    eventData.push({
                        data: ev.returnValues,
                        timestamp: eventTimestamp
                    });
                }
                return eventData;
            },
            default_wallet_address: async function() {
                return getNetworkAddress();
            },
            is_authenticated: async function(auth) {
                return auth.walletid !== undefined;
            },
            contract_list: async function(
                target,
                contractName,
                method,
                params = [],
                version = 'latest'
            ) {
                let i = 0;
                const results = [];
                while (true) {
                    try {
                        results.push(
                            await blockchain.callContract(
                                target,
                                contractName,
                                method,
                                params.concat([i]),
                                version
                            )
                        );
                    } catch (e) {
                        // todo: only if the error is related to the array bound? how can we standardize this.renderer?
                        break;
                    }

                    i++;

                    if (i > 50000) {
                        throw new Error('Something went wrong, more than 50000 iterations'); // todo
                    }
                }
                return results;
            },

            is_identity_registered: async function() {
                return await blockchain.isCurrentIdentityRegistered();
            },
            get_current_identity: async function() {
                return await blockchain.getCurrentIdentity();
            },
            identity_check_availability: async function(identity) {
                const owner = await blockchain.ownerByIdentity(identity);
                log.debug({identity, owner}, 'identity_check_availability');
                if (!owner || owner === '0x0000000000000000000000000000000000000000') return true;
                return false;
            },
            //generate the csrf token
            csrf_value: async function() {
                // todo: regenerate per session, or maybe store more permanently?
                if (!csrfTokens[this.host]) {
                    csrfTokens[this.host] = require('crypto')
                        .randomBytes(64)
                        .toString('hex');
                }
                return csrfTokens[this.host];
            },
            //create the field with csrf token.
            csrf_field: async function() {
                // todo: regenerate per session, or maybe store more permanently?
                if (!csrfTokens[this.host]) {
                    csrfTokens[this.host] = require('crypto')
                        .randomBytes(64)
                        .toString('hex');
                }
                return `<input name="_csrf" value="${csrfTokens[this.host]}" />`;
            },
            //check the csrf token.
            csrf_guard: async function(submitted_token) {
                //no token
                if (!csrfTokens) {
                    throw new Error(
                        'No csrf token generated for this host (rather, no tokens at all)'
                    );
                }
                //no token for the host
                if (!csrfTokens[this.host]) {
                    throw new Error('No csrf token generated for this host');
                }
                //invalid token
                const real_token = csrfTokens[this.host];
                if (real_token !== submitted_token) {
                    throw new Error('Invalid csrf token submitted');
                }
                return '';
            }

            // Privileged access functions (only scoped to https://point domain)

            // TODO: restore and reimplement
            // get_wallet_info: async function() {
            //     this.renderer.#ensurePrivilegedAccess();
            //
            //     const wallets = [];
            //     wallets.push({
            //         currency_name: 'Point',
            //         currency_code: 'POINT',
            //         address: (await blockchain.getCurrentIdentity()) + '.point' || 'N/A',
            //         balance: await this.renderer.ctx.wallet.getNetworkAccountBalanceInEth()
            //     });
            //     return wallets;
            // }
            // get_wallet_history: async function(code) {
            //     this.renderer.#ensurePrivilegedAccess();
            //     return await this.renderer.ctx.wallet.getHistoryForCurrency(code);
            // },
            // wallet_request_dev_sol: async function() {
            //     this.renderer.#ensurePrivilegedAccess();
            //     await this.renderer.ctx.wallet.initiateSolanaDevAirdrop();
            // }
            // wallet_send: async function(code, recipient, amount) {
            //     this.renderer.#ensurePrivilegedAccess();
            //     await this.renderer.ctx.wallet.send(code, recipient, amount);
            // }
        };
    }

    #ensurePrivilegedAccess() {
        if (this.host !== 'point') {
            throw new Error('This function requires privileged access, host is not supported');
        }
    }

    #defineAvailableFilters() {
        return {
            unjson: function(value) {
                return JSON.parse(value);
            }
        };
    }

    // TODO: this is a temporary hack unless we are using LocalDirectory, but
    // already got rid of Directory model
    async fetchTemplateByPath(templatePath) {
        if (this.rootDirId) {
            const templateFileId = await getFileIdByPath(this.rootDirId, templatePath);
            return getFile(templateFileId, 'utf8');
        } else {
            return readFileByPath(this.localDir, templatePath, 'utf-8');
        }
    }

    #getTwigForHost(host) {
        // Increment use counter
        this.#twigs_use_counter[host] = this.#twigs_use_counter[host] + 1 || 0;

        // Look in cache first
        if (this.#twigs[host]) {
            return this.#twigs[host];
        }

        // Spawning a new Twig object
        const Twig = TwigLib.factory();

        Twig.host = host;

        Twig.extend(ExtTwig => {
            ExtTwig.host = host;
            ExtTwig.renderer = this;
            ExtTwig.renderer.host = host;

            this.#connectExtendsTagToPointStorage(ExtTwig);
            this.#connectIncludeTagToPointStorage(ExtTwig);
            this.#connectThrowTag(ExtTwig);

            for (const [name, fn] of Object.entries(this.#defineAvailableFunctions())) {
                ExtTwig.exports.extendFunction(name, fn.bind(ExtTwig));
            }

            for (const [name, fn] of Object.entries(this.#defineAvailableFilters())) {
                ExtTwig.exports.extendFilter(name, fn.bind(ExtTwig));
            }

            this.#registerPointStorageFsLoader(ExtTwig);
        });

        // Save to our cache
        this.#twigs[host] = Twig;

        return Twig;
    }

    #removeTwigForHost(host) {
        this.#twigs_use_counter[host]--;

        if (this.#twigs_use_counter[host] === 0) {
            delete this.#twigs[host];
        }
    }

    #connectExtendsTagToPointStorage(Twig) {
        Twig.exports.extendTag({
            /**
             * Block logic tokens.
             *
             *  Format: {% extends "template.twig" %}
             */
            type: Twig.logic.type.extends_,
            regex: /^extends\s+(.+)$/,
            next: [],
            open: true,
            compile: function(token) {
                var expression = token.match[1].trim();
                delete token.match;
                token.stack = Twig.expression.compile.call(this, {
                    type: Twig.expression.type.expression,
                    value: expression
                }).stack;
                return token;
            },
            parse: function(token, context, chain) {
                var template,
                    that = this;

                //innerContext = Twig.ChildContext(context);
                // Twig.lib.copy = function (src) {
                var innerContext = {};
                let _key;
                for (_key in context) {
                    if (Object.hasOwnProperty.call(context, _key)) {
                        innerContext[_key] = context[_key];
                    }
                }

                // Resolve filename
                return Twig.expression.parseAsync
                    .call(that, token.stack, context)
                    .then(function(file) {
                        if (file instanceof Twig.Template) {
                            template = file;
                        } else {
                            // Import file
                            template = that.template.importFile(file);
                        }

                        // Set parent template
                        that.template.parentTemplate = file;

                        // Render the template in case it puts anything in its context
                        return template;
                    })
                    .then(function(template) {
                        return template.renderAsync(innerContext);
                    })
                    .then(function() {
                        // Extend the parent context with the extended context
                        context = {
                            ...context,
                            // override with anything in innerContext
                            ...innerContext
                        };

                        return {
                            chain: chain,
                            output: ''
                        };
                    });
            }
        });
    }

    #connectIncludeTagToPointStorage(Twig) {
        // Include tag - use Point Storage
        Twig.exports.extendTag({
            /**
             * Block logic tokens.
             *
             *  Format: {% includes "template.twig" [with {some: 'values'} only] %}
             */
            type: Twig.logic.type.include,
            regex: /^include\s+(.+?)(?:\s|$)(ignore missing(?:\s|$))?(?:with\s+([\S\s]+?))?(?:\s|$)(only)?$/,
            next: [],
            open: true,
            compile(token) {
                const {match} = token;
                const expression = match[1].trim();
                const ignoreMissing = match[2] !== undefined;
                const withContext = match[3];
                const only = match[4] !== undefined && match[4].length;

                delete token.match;

                token.only = only;
                token.ignoreMissing = ignoreMissing;

                token.stack = Twig.expression.compile.call(this, {
                    type: Twig.expression.type.expression,
                    value: expression
                }).stack;

                if (withContext !== undefined) {
                    token.withStack = Twig.expression.compile.call(this, {
                        type: Twig.expression.type.expression,
                        value: withContext.trim()
                    }).stack;
                }

                return token;
            },
            parse(token, context, chain) {
                // Resolve filename
                let innerContext = token.only ? {} : {...context};
                const {ignoreMissing} = token;
                const state = this;
                let promise = null;
                const result = {chain, output: ''};

                if (typeof token.withStack === 'undefined') {
                    promise = Twig.Promise.resolve();
                } else {
                    promise = Twig.expression.parseAsync
                        .call(state, token.withStack, context)
                        .then(withContext => {
                            innerContext = {
                                ...innerContext,
                                ...withContext
                            };
                        });
                }

                return promise
                    .then(() => Twig.expression.parseAsync.call(state, token.stack, context))
                    .then(file => {
                        let files;
                        if (Array.isArray(file)) {
                            files = file;
                        } else {
                            files = [file];
                        }
                        return files;
                    })
                    .then(files =>
                        files.reduce(
                            async (previousPromise, file) => {
                                const acc = await previousPromise;

                                const tryToRender = async file => {
                                    if (acc.render === null) {
                                        if (file instanceof Twig.Template) {
                                            const opts = {isInclude: true};
                                            const res = {
                                                render: await file.renderAsync(innerContext, opts),
                                                lastError: null
                                            };
                                            return res;
                                        }

                                        try {
                                            const res = {
                                                render: await (
                                                    await state.template.importFile(file)
                                                ).renderAsync(innerContext, {isInclude: true}),
                                                lastError: null
                                            };
                                            return res;
                                        } catch (error) {
                                            return {
                                                render: null,
                                                lastError: error
                                            };
                                        }
                                    }

                                    return acc;
                                };

                                return await tryToRender(file);
                            },
                            {render: null, lastError: null}
                        )
                    )
                    .then(finalResultReduce => {
                        if (finalResultReduce.render !== null) {
                            return finalResultReduce.render;
                        }

                        if (finalResultReduce.render === null && ignoreMissing) {
                            return '';
                        }

                        throw finalResultReduce.lastError;
                    })
                    .then(output => {
                        if (output !== '') {
                            result.output = output;
                        }

                        return result;
                    });
            }
        });
    }

    #connectThrowTag(Twig) {
        Twig.exports.extendTag({
            /**
             *  Format: {% throw "Error message" %}
             */
            type: 'throw',
            regex: /^throw\s+(.+?)$/,
            next: [],
            open: true,
            compile(token) {
                const {match} = token;
                const expression = match[1].trim();

                delete token.match;

                token.stack = Twig.expression.compile.call(this, {
                    type: Twig.expression.type.expression,
                    value: expression
                }).stack;

                return token;
            },
            parse(token, context) {
                const state = this;
                let promise = null;

                promise = Twig.Promise.resolve();

                return promise
                    .then(() => Twig.expression.parseAsync.call(state, token.stack, context))
                    .then(errorMsg => {
                        throw new Error(errorMsg);
                    });
            }
        });
    }

    #registerPointStorageFsLoader(Twig) {
        Twig.Templates.registerLoader('fs', async (location, params, callback) => {
            // ... load the template ...
            const src = await this.fetchTemplateByPath(params.path);
            params.data = src;
            params.allowInlineIncludes = true;
            // create and return the template
            var template = new Twig.Template(params);
            if (typeof callback === 'function') {
                callback(template);
            }
            return template;
        });
    }
}

module.exports = Renderer;
