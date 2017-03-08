import imaps from 'imap-simple';
import winston from 'winston';
import request from 'request-promise-native';
import config from 'config';

const ACCOUNT_ACTIVATED = 'Your account is now active.';
const ACCOUNT_ALREADY_ACTIVATED = 'Your account has already been activated.';

const logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({
            timestamp: () => {
                return Date.now();
            },
            formatter: (options) => {
                return '['+ new Date(options.timestamp()).toISOString() +']['+ options.level.toUpperCase() +'] '+ (options.message ? options.message : '') +
                    (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' );
            },
            level: config.get('verbosity'),
        }),
    ],
});

let conn = {imap: config.get('imap')};

//  Fallback to avoid errors, because simple-imap tries to modify this value,
// which is read-only if it come from the config.
conn.imap.authTimeout = config.get('imap.timeout');

logger.info('Connecting to IMAP server...');
imaps.connect(conn).then(connection => {
    logger.debug('Connected!');
    logger.debug('Opening the inbox folder...');
    
    return connection.openBox('INBOX').then(() => {
        let criteria = [
            'UNSEEN',
            [ 'SUBJECT', 'Pokémon Trainer Club Activation' ]
        ];
        
        let fetchOpts = {
            bodies: [ 'HEADER.FIELDS (TO)', 'TEXT' ],
            markSeen: false,
        };
        
        logger.info('Searching for unread emails...');
        return connection.search(criteria, fetchOpts).then(messages => {
            logger.info(`There are ${messages.length} unread activation messages.`);
            logger.debug('Reading each message...');
            
            let counter = 0;
            
            let messagesPromises = messages.map(message => {
                let messagePromise = new Promise((resolve, reject) => {
                    counter += 1;
                    logger.debug(`Reading message #${counter} - ${message.attributes.uid}`);
                    
                    let to = message.parts.filter(part => {
                        return part.which === 'HEADER.FIELDS (TO)';
                    });
                    
                    to = to[0].body.to[0].replace(/[\<\>]/g, '');
                    
                    message.parts.filter(part => {
                        return part.which === 'TEXT';
                    }).map(part => {
                        let linkRE = /(https\:\/\/club[a-z0-9\.\/\-]*)\b/g;
                        
                        let link = linkRE.exec(part.body);
                        link = link[0];
                        
                        logger.info(`Validating the account "${to}".`);
                        
                        let req = request(link);
                        req.then(body => {
                            if (body.indexOf(ACCOUNT_ACTIVATED) >= 0) {
                                logger.info(`The account "${to}" has been activated.`);
                            } else if (body.indexOf(ACCOUNT_ALREADY_ACTIVATED) >= 0) {
                                logger.info(`The account "${to}" has already been activated.`);
                            } else {
                                console.log(body);
                                process.exit(1);
                            }
                            
                            let seen = connection.addFlags(message.attributes.uid, 'SEEN');
                            seen.then(() => {
                                logger.debug(`Email ${message.attributes.uid} marked as read.`);
                                resolve();
                            }).catch(err => {
                                logger.error(err);
                                reject();
                            });
                        });
                    });
                });
                
                return messagePromise;
            });
            
            return Promise.all(messagesPromises);
        }).then(messages => {
            logger.info(`Done. ${messages.length} messages marked as read.`);
            
            connection.end();
            process.exit(0);
        });
    });
}).catch(reason => {
    logger.error(reason);
});
