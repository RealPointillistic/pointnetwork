import https from 'https';
import Fastify from 'fastify';
import {getCertificate} from './certificates';
import tls from 'tls';
import logger from '../../core/log';
import fastifyUrlData from '@fastify/url-data';
import fastifyMultipart from '@fastify/multipart';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from 'fastify-websocket';
import {transformErrorResp} from '../../errors';
import attachHandlers from './handlers';
import {cors} from './middleware';

const log = logger.child({module: 'Proxy'});
const httpsServer = Fastify({
    serverFactory(handler) {
        const server = https.createServer(
            {
                SNICallback: (servername, cb) => {
                    const certData = getCertificate(servername);
                    const secureContext = tls.createSecureContext(certData);

                    if (!secureContext) {
                        log.debug({servername}, `Not found SSL certificate for host`);
                    } else {
                        log.trace({servername}, `SSL certificate has been found and assigned`);
                    }

                    if (typeof cb !== 'function') {
                        return secureContext;
                    }

                    cb(null, secureContext);
                }
            },
            handler
        );

        server.on('error', e => log.error(e, 'HTTPS server error:'));

        return server;
    },
    trustProxy: '127.0.0.1',
    logger: log.child({module: 'Http Fastify server'}, {level: 'warn'})
});
httpsServer.register(fastifyUrlData);
httpsServer.register(fastifyMultipart);
httpsServer.register(fastifyFormBody);
httpsServer.register(fastifyWs);

httpsServer.addHook('preHandler', cors);
httpsServer.addHook('onSend', transformErrorResp);

attachHandlers(httpsServer);

export default httpsServer;
