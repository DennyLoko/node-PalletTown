import config from 'config'
import FakeSelenium from './fakeselenium'
import imap from 'imap-simple'
import mysql from 'mysql'
import request from 'request-promise-native';
import {Builder, By, until} from 'selenium-webdriver';
import winston from 'winston'

const ACCOUNT_ACTIVATED = 'Your account is now active.'
const ACCOUNT_ALREADY_ACTIVATED = 'Your account has already been activated.'
const INVALID_CONFIRMATION_TOKEN = 'We cannot find an account matching the confirmation email.'
const VERIFICATION_EMAIL_SENT = 'We have sent you an email to verify your account.'
const RATE_LIMITING_ERROR = '403 Forbidden'
const UNHANDLED_ERROR = 'Unhandled error.'

const logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({
      timestamp: () => {
        return Date.now()
      },
      formatter: (options) => {
        return '['+ new Date(options.timestamp()).toISOString() +']['+ options.level.toUpperCase() +'] '+ (options.message ? options.message : '') +
        (options.meta && Object.keys(options.meta).length ? '\n\t'+ JSON.stringify(options.meta) : '' )
      },
      level: config.get('verbosity'),
    }),
  ],
})

const conn = {imap: config.get('imap')}

//  Fallback to avoid errors, because simple-imap tries to modify this value,
// which is read-only if it come from the config.
conn.imap.authTimeout = config.get('imap.timeout')

const searchAccount = (conn, login) => {
  return new Promise((resolve, reject) => {
    conn.query({
      sql: 'SELECT id FROM accounts WHERE login = ?',
      values: [
        login
      ]
    }, (err, results) => {
      if (err) {
        return reject(err)
      }

      if (results.length == 0) {
        return resolve(null)
      } else {
        return resolve(results[0].id)
      }
    })
  })
}

const insertAccount = (conn, login, email) => {
  return new Promise((resolve, reject) => {
    logger.info(`Inserting account "${login}" into database.`)
    
    const account = [
      login, config.get('default_password'), email,
    ]
    
    conn.query('INSERT INTO accounts(login, password, email) VALUES(?, ?, ?)', account, (err, result) => {
      if (err) {
        logger.error('Failed to query the database. Error: ' + err)
        return reject(err)
      }
      
      return resolve(result.insertId)
    })
  })
}

const updateAccount = (conn, activated, id) => {
  return new Promise((resolve, reject) => {
    const d = new Date()
    const updated_at = d.getFullYear()+"-"+d.getMonth()+"-"+d.getDay()+" "+d.getHours()+":"+d.getMinutes()+":"+d.getSeconds()
    const account = [
      activated, updated_at, id
    ]
    
    conn.query('UPDATE accounts SET activated=?, updated_at=? WHERE id=?', account, (err, result, fields) => {
      if (err) {
        logger.error('Failed to query the database. Error: ' + err)
        return reject(err)
      }
      
      return resolve(id)
    })
  })
}

const newRequest = (url) => {
  return new Promise((resolve, reject) => {
    if (config.get('request_type') == 'selenium') {
      const driver = new Builder().forBrowser(config.get('webdriver')).build()
      driver.get(url)
      
      const t = 5 * 1000
      
      driver.wait(until.elementLocated(By.id('sign-up-theme')), t).then(() => {
        driver.getPageSource().then(body => {
          resolve([body, driver])
        }).catch(err => {
          reject(err)
        })
      }).catch(err => {
        driver.getTitle().then(title => {
          if (title === RATE_LIMITING_ERROR) {
            reject({statusCode: 503})
          } else {
            reject(err)
          }
        })
      })
    } else {
      const req = request(url)
      req.then(body => {
        resolve([body, new FakeSelenium()])
      }).catch(err => {
        reject(err)
      })
    }
  })
}

const requestNewValidationEmail = (driver, link, login, password) => {
  return new Promise((resolve, reject) => {
    const t = 5 * 1000
    
    driver.wait(until.elementLocated(By.id('sign-up-theme')), t).then(() => {
      logger.info(`Asking a new verification email for the account ${login}...`)
      
      logger.debug(`Writing username...`)
      const loginElm = driver.findElement(By.name('username'))
      loginElm.sendKeys(login)
      
      logger.debug(`Writing password...`)
      const pwdElem = driver.findElement(By.name('password'))
      pwdElem.sendKeys(password)
      
      logger.debug(`Submiting form...`)
      pwdElem.submit()
      
      driver.wait(until.elementLocated(By.id('sign-up-theme')), t).then(() => {
        driver.getPageSource().then(body => {
          if (body.indexOf(VERIFICATION_EMAIL_SENT) >= 0) {
            logger.info(`Success requesting the new verification email for the account ${login}!`)
            driver.quit()
            
            resolve()
          }
        })
      }).catch(() => {
        setTimeout(() => {
          driver.get(link)
          
          requestNewValidationEmail(driver, link, login, password).then(() => {
            resolve()
          })
        }, 60000)
      })
    }).catch(() => {
      requestNewValidationEmail(driver, link, login, password).then(() => {
        resolve()
      })
    })
  })
}

const validateAccount = (link, id, login, password) => {
  return new Promise((resolve, reject) => {
    newRequest(link).then(data => {
      let body
      let driver
      [body, driver] = data
      
      if (body.indexOf(ACCOUNT_ACTIVATED) >= 0) {
        logger.info(`The account "${login}"(${id}) has been activated.`)
        driver.quit()
        
        resolve(['Y', id])
      } else if (body.indexOf(ACCOUNT_ALREADY_ACTIVATED) >= 0) {
        logger.info(`The account "${login}"(${id}) has already been activated.`)
        driver.quit()
        
        resolve(['Y', id])
      } else if (body.indexOf(INVALID_CONFIRMATION_TOKEN) >= 0) {
        logger.info(`The activation link for "${login}"(${id}) has already expired.`)
        
        requestNewValidationEmail(driver, link, login, password).then(() => {
          resolve(['N', id])
        }).catch(err => {
          reject(err)
        })
      }
    }).catch(err => {
      if (typeof err.statusCode !== undefined && err.statusCode === 503) {
        logger.error(`Error 503 while activating the account "${id}". Waiting ~1min...`);
        
        setTimeout(() => {
          validateAccount(link, id, login, password).then(details => {
            resolve(details)
          })
        }, 65000)
      } else {
        console.log(err)
        process.exit(0)
      }
    })
  })
}

const iterateOverMessages = (imap_connection, messages, mysql_connection) => {
  logger.info(`There are ${messages.length} unread activation messages.`)
  logger.debug('Reading each message...')
  
  let counter = 0
  
  const messagesPromises = messages.map(message => {
    const messagePromise = new Promise((resolve, reject) => {
      counter += 1
      logger.debug(`Reading message #${counter} - ${message.attributes.uid}`)
      
      let to = message.parts.filter(part => {
        return part.which === 'HEADER.FIELDS (TO)'
      })
      
      to = to[0].body.to[0].replace(/[\<\>]/g, '')
      
      message.parts.filter(part => {
        return part.which === 'TEXT'
      }).map(part => {
        const linkRE = /(https\:\/\/club[a-z0-9\.\/\-]*)\b/g
        
        let link = linkRE.exec(part.body)
        link = link[0]
        
        let _
        let login
        [login, _] = to.split('@')
        
        searchAccount(mysql_connection, login).then(id => {
          if (id == null) {
            return insertAccount(mysql_connection, login, to)
          } else {
            return id
          }
        })
        .then(id => {
          return validateAccount(link, id, login, config.get('default_password'))
        })
        .then(details => {
          let activated
          let id
          
          [activated, id] = details
          
          return updateAccount(mysql_connection, activated, id)
        })
        .then(() => { 
          return imap_connection.addFlags(message.attributes.uid, 'SEEN')
        })
        .then(() => {
          logger.debug(`Email ${message.attributes.uid} marked as read.`)
          return resolve()
        })
        .catch(err => {
          logger.error(err)
        })
      })
    })
    
    return messagePromise
  })
  
  return Promise.all(messagesPromises)
}

const searchMessages = (imap_connection, start, mysql_connection) => {
  return imap_connection.openBox('INBOX').then(() => {
    const end = start + config.get('imap.batch')
    
    const fetchOpts = {
      bodies: [ 'HEADER.FIELDS (TO)', 'TEXT' ],
      markSeen: false,
    }
    
    let criteria = [
      'UNSEEN',
      [ 'SUBJECT', 'Trainer Club Activation' ],
      [ 'UID', `${start}:${end}` ],
    ]
    
    logger.info('Searching for unread emails...')
    
    return imap_connection
      .search(criteria, fetchOpts)
      .then(messages => iterateOverMessages(imap_connection, messages, mysql_connection))
      .then(messages => {
        if (messages.length >= 0) {
          searchMessages(imap_connection, end, mysql_connection)
        }
      })
  })
}

logger.info('Connecting to IMAP server...')
imap.connect(conn).then(connection => {
  logger.debug('Connected!')
  
  connection.on('error', (err) => {
    logger.error(err)
  })
  
  const mysql_connection = mysql.createConnection(config.get('mysql'))
  
  logger.debug('Connecting to MySQL server...')
  mysql_connection.connect((err) => {
    if (err) {
      logger.error('Failed to connect to MySQL server. Error: ' + err)
      process.exit(1)
    }
  })
  
  mysql_connection.on('error', function(err) {
    console.log(err.code);
    process.exit(0)
  });
  
  logger.debug('Opening the inbox folder...')
  searchMessages(connection, config.get('imap.start'), mysql_connection).then(() => {
    logger.info(`Done. ${messages.length} messages marked as read.`)
    
    // Clean up
    connection.end()
    mysql_connection.end()
    
    process.exit(0)
  })
}).catch(reason => {
  logger.error(reason)
})
