const PointSDKController = require('./PointSDKController');
const {ethereumjs} = require('ethereumjs-util');
const ethereum = require('../../network/providers/ethereum');
const {getNetworkPublicKey, getNetworkPrivateKey} = require('../../wallet/keystore');
const {
    encryptData,
    decryptData,
    decryptSymmetricKey,
    decryptDataWithDecryptedKey,
    getEncryptedSymetricObjFromJSON
} = require('../../client/encryptIdentityUtils');
const {getBalance, getWalletAddress, sendTransaction, sendToken} = require('../../wallet');
const config = require('config');
const Web3 = require('web3');
const ERC20 = require('../../abi/ERC20.json');
const {utils} = require('ethers');
const {getIdentity} = require('../../name_service/identity');

const networks = config.get('network.web3');
const DEFAULT_NETWORK = config.get('network.default_network');

const timeout = (prom, time, exception) => {
    let timer;
    return Promise.race([
        prom,
        new Promise((_r, rej) => (timer = setTimeout(rej, time, exception)))
    ]).finally(() => clearTimeout(timer));
};

class WalletController extends PointSDKController {
    constructor(req, reply) {
        super(req);
        this.req = req;
        this.payload = req.body;
        this.reply = reply;
    }

    publicKey() {
        const publicKey = getNetworkPublicKey();

        return this._response({publicKey});
    }

    address() {
        return this._response({address: getWalletAddress({network: this.req.query.network})});
    }

    async balance() {
        // return the wallet balance
        return this._response({balance: await getBalance({network: this.req.query.network})});
    }

    hash() {
        const partialPK = getNetworkPrivateKey().slice(0, 33);
        const hashBuffer = ethereumjs.sha256(Buffer.from(partialPK));
        const hash = ethereumjs.bufferToHex(hashBuffer);

        return this._response({hash});
    }

    async getWalletInfo() {
        const identity = await ethereum.getCurrentIdentity();
        const pointIdentity = identity ? `${identity}.point` : 'N/A';
        const wallets = [
            ...(await Promise.all(
                Object.keys(networks).map(async network => {
                    let balance;
                    let alias = '';

                    await Promise.all([
                        (async () => {
                            try {
                                balance = await timeout(
                                    getBalance({network, majorUnits: true}),
                                    5000,
                                    'Timeout'
                                );
                            } catch (e) {
                                balance = 'Error';
                            }
                        })(),
                        (async () => {
                            try {
                                switch (network) {
                                    case 'solana':
                                        const snsData = await timeout(
                                            getIdentity({targets: ['solana']}),
                                            5000,
                                            'Timeout'
                                        );
                                        alias = snsData.identity ?? '';
                                        break;
                                    case 'rinkeby':
                                        const ensData = await timeout(
                                            getIdentity({targets: ['ethereum']}),
                                            5000,
                                            'Timeout'
                                        );
                                        alias = ensData.identity ?? '';
                                        break;
                                    default:
                                        alias = '';
                                }
                            } catch (e) {
                                alias = '';
                            }
                        })()
                    ]);

                    return {
                        network,
                        type: networks[network].type,
                        currency_name: networks[network].currency_name,
                        currency_code: networks[network].currency_code,
                        // TODO: improve this condition as we will have multiple point networks
                        address:
                            network === DEFAULT_NETWORK
                                ? pointIdentity
                                : getWalletAddress({network}),
                        alias,
                        balance: balance
                    };
                })
            ))
        ];

        return this._response({wallets});
    }

    async getTokenBalances() {
        const tokens = Object.keys(networks)
            .filter(key => networks[key].type === 'eth')
            .reduce((acc, cur) => ({...acc, [cur]: networks[cur].tokens}), {});

        const web3 = new Web3();
        const decimalsCallData = web3.eth.abi.encodeFunctionCall(
            ERC20.find(func => func.name === 'decimals'),
            []
        );
        const balanceOfCallData = web3.eth.abi.encodeFunctionCall(
            ERC20.find(func => func.name === 'balanceOf'),
            [getWalletAddress({})]
        );

        await Promise.all(
            Object.keys(tokens).map(async network => {
                const balances = await Promise.all(
                    tokens[network].map(async token => {
                        try {
                            const [balance, decimals] = await Promise.all([
                                timeout(
                                    ethereum.send({
                                        method: 'eth_call',
                                        params: [
                                            {
                                                from: getWalletAddress({}),
                                                to: token.address,
                                                data: balanceOfCallData
                                            },
                                            'latest'
                                        ],
                                        id: new Date().getTime(),
                                        network
                                    }),
                                    5000,
                                    'Timeout'
                                ),
                                timeout(
                                    ethereum.send({
                                        method: 'eth_call',
                                        params: [
                                            {
                                                from: getWalletAddress({}),
                                                to: token.address,
                                                data: decimalsCallData
                                            },
                                            'latest'
                                        ],
                                        id:
                                            new Date().getTime() +
                                            Math.round(Math.random() * 100000),
                                        network
                                    }),
                                    5000,
                                    'Timeout'
                                )
                            ]);
                            return {
                                balance: utils.formatUnits(
                                    balance.result.toString(),
                                    decimals.result.toString()
                                ),
                                decimals: Number(decimals.result.toString())
                            };
                        } catch (e) {
                            return {
                                balance: e,
                                decimals: ''
                            };
                        }
                    })
                );

                tokens[network] = tokens[network].map((token, index) => ({
                    ...token,
                    balance: balances[index].balance,
                    decimals: balances[index].decimals
                }));
            })
        );

        return this._response(tokens);
    }

    async send() {
        const {to, network, value, messageId} = this.payload;
        return sendTransaction({to, network, value, messageId});
    }

    async sendToken() {
        const {tokenAddress, to, network, value, messageId} = this.payload;

        return sendToken({tokenAddress, to, network, value, messageId});
    }

    async encryptData() {
        const {publicKey, data} = this.payload;
        const {host} = this.req.headers;
        const encryptedData = await encryptData(host, data, publicKey);
        return this._response(encryptedData);
    }

    async decryptSymmetricKey() {
        const {host} = this.req.headers;
        const privateKey = getNetworkPrivateKey();

        const encryptedSymmetricObj = getEncryptedSymetricObjFromJSON(
            JSON.parse(this.payload.encryptedSymmetricObj)
        );
        const decryptedSymmetricKey = await decryptSymmetricKey(
            host,
            encryptedSymmetricObj,
            privateKey
        );
        return this._response({decryptedSymmetricKey});
    }

    async decryptDataWithDecryptedKey() {
        const {host} = this.req.headers;
        
        const decryptedData = await decryptDataWithDecryptedKey(
            host,
            Buffer.from(this.payload.encryptedData, 'hex'),
            this.payload.symmetricObj
        );
        return this._response({decryptedData: decryptedData.plaintext.toString()});
    }

    async decryptData() {
        const {host} = this.req.headers;
        const privateKey = getNetworkPrivateKey();

        const encryptedSymmetricObj = getEncryptedSymetricObjFromJSON(
            JSON.parse(this.payload.encryptedSymmetricObj)
        );
        const decryptedData = await decryptData(
            host,
            Buffer.from(this.payload.encryptedData, 'hex'),
            encryptedSymmetricObj,
            privateKey
        );
        return this._response({decryptedData: decryptedData.plaintext.toString()});
    }
}

module.exports = WalletController;
