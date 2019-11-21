const Web3 = require('web3');
const log4js = require('log4js');

//configurations
const config = require('./config.js');
const logConfig = require('./log-config.json');
const abiBridge = require('./src/abis/Bridge_v0.json');
const abiMainToken = require('./src/abis/IERC20.json');
//utils
const TransactionSender = require('./src/lib/TransactionSender.js');
const Federator = require('./src/lib/Federator.js');
const utils = require('./src/lib/utils.js');

const logger = log4js.getLogger('test');
log4js.configure(logConfig);
logger.info('----------- Transfer Test ---------------------');
logger.info('Mainchain Host', config.mainchain.host);
logger.info('Sidechain Host', config.sidechain.host);

const sideConfig = {
    ...config,
    confirmations: 0,
    mainchain: config.sidechain,
    sidechain: config.mainchain,
};

const mainKeys = process.argv[2] ? process.argv[2].split(',') : [];
const sideKeys = process.argv[3] ? process.argv[3].split(',') : [];

const mainchainFederators = getMainchainFederators(mainKeys);
const sidechainFederators = getSidechainFederators(sideKeys, sideConfig);

run({ mainchainFederators, sidechainFederators, config, sideConfig });

function getMainchainFederators(keys) {
    let federators = [];
    if (keys && keys.length) {
        keys.forEach((key, i) => {
            let federator = new Federator({
                ...config,
                privateKey: key,
                storagePath: `${config.storagePath}/fed-${i + 1}`
            }, log4js.getLogger('FEDERATOR'));
            federators.push(federator);
        });
    } else {
        let federator = new Federator(config, log4js.getLogger('FEDERATOR'));
        federators.push(federator);
    }
    return federators;
}

function getSidechainFederators(keys, sideConfig) {
    let federators = [];
    if (keys && keys.length) {
        keys.forEach((key, i) => {
            let federator = new Federator({
                ...sideConfig,
                privateKey: key,
                storagePath: `${config.storagePath}/rev-fed-${i + 1}`
            },
            log4js.getLogger('FEDERATOR'));
            federators.push(federator);
        });
    } else {
        let federator = new Federator({
            ...sideConfig,
            storagePath: `${config.storagePath}/rev-fed`,
        }, log4js.getLogger('FEDERATOR'));
        federators.push(federator);
    }
    return federators;
}

async function run({ mainchainFederators, sidechainFederators, config, sideConfig }) {
    logger.info('Starting transfer from Mainchain to Sidechain');
    await transfer(mainchainFederators, config, 'MAIN', 'SIDE');
    logger.info('Completed transfer from Mainchain to Sidechain');

    logger.info('Starting transfer from Sidechain to Mainchain');
    await transfer(sidechainFederators, sideConfig, 'SIDE', 'MAIN');
    logger.info('Completed transfer from Sidechain to Mainchain');
}

async function transfer(federators, config, origin, destination) {
    try {
        let originWeb3 = new Web3(config.mainchain.host);
        let destinationWeb3 = new Web3(config.sidechain.host);

        const originTokenContract = new originWeb3.eth.Contract(abiMainToken, config.mainchain.testToken);
        const transactionSender = new TransactionSender(originWeb3, logger);

        const originBridgeAddress = config.mainchain.bridge;
        const amount = originWeb3.utils.toWei('1');
        const originAddress = originTokenContract.options.address;

        logger.debug('Getting address from pk');
        const senderAddress = await transactionSender.getAddress(config.mainchain.privateKey);
        logger.info(`${origin} token addres ${originAddress} - Sender Address: ${senderAddress}`);

        logger.debug('Aproving token transfer');
        let data = originTokenContract.methods.approve(originBridgeAddress, amount).encodeABI();
        await transactionSender.sendTransaction(originAddress, data, 0, config.mainchain.privateKey);
        logger.debug('Token transfer approved');

        logger.debug('Bridge receiveTokens (transferFrom)');
        let bridgeContract = new originWeb3.eth.Contract(abiBridge, originBridgeAddress);
        data = bridgeContract.methods.receiveTokens(originAddress, amount).encodeABI();
        await transactionSender.sendTransaction(originBridgeAddress, data, 0, config.mainchain.privateKey);
        logger.debug('Bridge receivedTokens completed');

        let waitBlocks = config.confirmations;
        logger.debug(`Wait for ${waitBlocks} blocks`);
        await utils.waitBlocks(originWeb3, waitBlocks);

        logger.debug('Starting federator processes');
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        // Start federators with delay between them
        await federators.reduce(function(promise, item) {
            return promise.then(function() {
                return Promise.all([delay(5000), item.run()]);
            })
        }, Promise.resolve());

        logger.debug('Get the destination token address');
        let destinationBridgeContract = new destinationWeb3.eth.Contract(abiBridge, config.sidechain.bridge);
        let destinationTokenAddress = await destinationBridgeContract.methods.mappedTokens(originAddress).call();
        logger.info(`${destination} token address`, destinationTokenAddress);

        logger.debug('Check balance on the other side');
        let destinationTokenContract = new destinationWeb3.eth.Contract(abiMainToken, destinationTokenAddress);
        let balance = await destinationTokenContract.methods.balanceOf(senderAddress).call();
        logger.info(`${destination} token balance`, balance);

    } catch(err) {
        logger.error('Unhandled Error on transfer()', err.stack);
        process.exit();
    }

}
