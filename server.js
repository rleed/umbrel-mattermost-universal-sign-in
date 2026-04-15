const { parseArgs } = require('node:util')
const fs = require('fs')
const path = require('path')
const express = require('express')
const { exec } = require("child_process")
const bm = require('bitcoinjs-message')
const bl = require('bitcoinjs-lib')
const z32 = require('z32')
const qrlib = require('qrcode')

import('lowdb/node').then(lowdb_node => {
  JSONFile = lowdb_node.JSONFile
import('lowdb').then(lowdb => {
  Low = lowdb.Low

const options = {
  port: {
    type: 'string',
    short: 'p',
    default: '8066',
  },
  datapath: {
    type: 'string',
    short: 'd',
    default: '',
  },
  mattermost: {
    type: 'string',
    short: 'i',
    default: 'https://my.mattermost.instance',
  },
  token: {
    type: 'string',
    short: 't',
  },
  password: {
    type: 'string',
    short: 'P',
  },
  route: {
    type: 'string',
    short: 'r',
    default: '/sign-in'
  },
  admin: {
    type: 'string',
    short: 'a',
    default: '/'
  },
  mempool: {
    type: 'string',
    short: 'm',
    default: 'https://mempool.space',
  },
  team: {
    type: 'string',
    short: 'w',
    default: 'welcome',
  },
  message: {
    type: 'string',
    short: 'M',
    default: `\
I, the undersigned, hereby access {domain} as of {blocktime} ({minihash}) \
subject to the terms and policies.`
  },
  terms: {
    type: 'string',
    short: 'T',
    default: `\
I, the undersigned, pledge to the members of the {domain} community never \
to report nor reveal their personal data including transaction data without \
a search warrant, and I agree to the terms and policies on file. Date: {blocktime} ({minihash})`
  },
}

const { values: opts, positionals: args } = parseArgs({
  options,
  allowPositionals: true,
})

const adapter1 = new JSONFile(`${opts.datapath}users.json`)
const db = new Low(adapter1, {})
db.read()
const adapter2 = new JSONFile(`${opts.datapath}activity.json`)
const activity = new Low(adapter2, [])
activity.read()

let team_id = undefined

var app = express()
var app_options = {}


function base64ToBytes(base64) {
  const binString = Buffer.from(base64, 'base64').toString('utf8');
  return Uint8Array.from(binString, (m) => m.codePointAt(0));
}

app.get(`${opts.route}/qr`, (req, res) => {
  const text = req.query.text || 'Hello World'
  try {
    qrlib.toDataURL(text).then(qrDataUrl => {
      res.send(`<img src="${qrDataUrl}" alt="QR Code">`)
    }).catch(e => {
      console.log(`error generating data URL: ${e}`)
      res.status(500).end()
    })
  } catch (e) {
    console.log(`error generating QR code: ${e}`)
    res.status(500).end()
  }
})

const get_options = {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${opts.token}`,
    'Accept': 'application/json'
  }
}
const post_options = {
  method: 'POST',
  credentials: 'include',
  headers: {
    'X-Requested-With': 'XMLHttpRequest',
    'Authorization': `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
}


function loginMattermost(res, id) {
  const injectSession = (username) => {
    return new Promise((resolve, reject) => {
      //console.log(`getting session token for ${username}`)
      fetch(`${opts.mattermost}/api/v4/users/login`, { ...post_options, body: JSON.stringify({
        login_id: username,
        password: opts.password
      })}).then(r => {
        const setCookieHeaders = r.headers.getSetCookie()
        const cookies = {};
        for (const cookieString of setCookieHeaders) {
          const [keyValuePair, ...attributes] = cookieString.split(';')
          const [key, value] = keyValuePair.split('=').map(s => s.trim())
          if (key && value) {
            cookies[key] = value
          }
        }
        //console.log(`injecting session cookies for ${username}: ${JSON.stringify(cookies)}`)
        res.cookie('MMUSERID',    cookies['MMUSERID'],    { maxAge: 30*24*60*60*1000, secure: true })
        res.cookie('MMCSRF',      cookies['MMCSRF'],      { maxAge: 30*24*60*60*1000, secure: true })
        res.cookie('MMAUTHTOKEN', cookies['MMAUTHTOKEN'], { maxAge: 30*24*60*60*1000, secure: true })
        resolve()
      })
    })
  }
  return new Promise((resolve, reject) => {
    import('@noble/hashes/sha2.js').then(hashes => {
      const hash = Buffer.from(hashes.sha256(new TextEncoder().encode(id)))
      const l = hash.length/4
      let a = ''
      for (i=0; i<l; i++) {
        let b = hash[i] ^ hash[i+l] ^ hash[i+l*2] ^ hash[i+l*3]
        a += ('0'+b.toString(16)).slice(-2)
      }
      a = a.split('').map(c => String.fromCharCode(c.charCodeAt(0) + (/\d/.test(c)? 97-48: 10))).join('')
      const shortcode = a

      let user_id = db.data[id]
      if (!user_id) {

        // create new user
        console.log(`creating new user account ${shortcode}`)
        fetch(`${opts.mattermost}/api/v4/users`, { ...post_options, body: JSON.stringify({
          username: shortcode,
          password: opts.password,
          email: `${shortcode}@satoshidnc.com`
        })}).then(r => r.json()).then(json => {
          if (json.email == `${shortcode}@satoshidnc.com` && json.id) {
            user_id = json.id
            db.data[id] = user_id
            db.write().then(()=>{}).catch(e => console.log(`error writing db: ${e}`))

            // add user to team
            const addToTeam = () => {
              fetch(`${opts.mattermost}/api/v4/teams/${team_id}/members`, { ...post_options, body: JSON.stringify({
                team_id: team_id,
                user_id: user_id
              })}).then(r => r.json()).then(json => {
                if (json.team_id == team_id && json.user_id == user_id) {
                  // log in
                  injectSession(shortcode).then(() => {
                    resolve({
                      id: user_id
                    })
                  })
                } else {
                  reject(`error adding user to team: ${JSON.stringify(json)}`)
                }
              })
            }
            // find team
            if (!team_id) {
              fetch(`${opts.mattermost}/api/v4/teams/name/${opts.team}`, get_options).then(r => r.json()).then(json => {
                if (json.name == opts.team && json.id) {
                  team_id = json.id
                  addToTeam()
                } else {
                  reject(`error finding team: ${JSON.stringify(json)}`)
                }
              })
            } else {
              addToTeam()
            }
          } else {
            reject(`error creating account ${shortcode}: ${JSON.stringify(json)}`)
          }
        })

      } else {
        fetch(`${opts.mattermost}/api/v4/users/${user_id}`, get_options).then(r => r.json()).then(json => {
          if (json.id == user_id) {
            injectSession(json.username).then(() => {
              resolve({
                id: json.id
              })
            })
          } else {
            console.log(`error querying mattermost user ${user_id}`)
            reject(JSON.stringify(json))
          }
        }).catch(e => { reject(e) })

      }
    })
  })
}


function verifyLightningMessage(pubkeyHex, messageString, zbase32Signature) {
  return new Promise((resolve, reject) => {
    import('@noble/secp256k1').then(secp => {
    import('@noble/hashes/sha2.js').then(hashes => {
      secp.hashes.sha256 = hashes.sha256
      try {
        valid = secp.verify(
          z32.decode(zbase32Signature).slice(1),
          hashes.sha256(new TextEncoder().encode('Lightning Signed Message:'+messageString)),
          Buffer.from(pubkeyHex, 'hex'))
        resolve(valid)
      } catch (e) {
        //console.error(e)
        resolve(false)
      }
    })})
  })
}


function verify(id, message, sig) {
  return new Promise((resolve, reject) => {

    // check for valid lightning signed message
    let pubkey = id
    atSign = id.indexOf('@')
    if (atSign !== -1) {
      pubkey = pubkey.slice(0, atSign)
    }
    verifyLightningMessage(pubkey, message, sig).then(valid => {
      if (valid) {
        resolve({
          scheme: 'Lightning Signed Message',
          loginId: pubkey,
          message,
          sig
        })
      } else {

        // check for valid bitcoin signed message
        try {
          valid = bm.verify(message, id, sig, null, true)
        } catch (e) {
        }
        if (valid) {
          resolve({
            scheme: 'Bitcoin Signed Message',
            loginId: id,
            message,
            sig
          })
        } else {

          // all attempts failed
          reject('not valid according to any supported signature scheme')
        }
      }
    })
  })
}



app.get(opts.route, function (req, res) {

  // sanity check domain name
  const proto = req.protocol
  const domain = req.get('host')
  if (`https://${domain}` != opts.mattermost) {
    console.log(`domain mismatch: https://${domain} vs ${opts.mattermost}`)
    res.redirect(opts.mattermost)
    return
  }

  // establish block time
  fetch(`${opts.mempool}/api/blocks/tip/hash`).then(r => r.text()).then(text => {

    const hash = text
    if (!/[0-9a-f]/.test(hash)) {
      console.log(`error getting block tip: ${text}`)
      res.status(503).send('The mempool service is unavailable: please inform the administrator.')
      return
    }

    fetch(`${opts.mempool}/api/block/${hash}`).then(r => r.json()).then(block => {
      const b = block.height
      const y = Math.floor(b / 52500)
      const yb = b % 52500
      const ym = Math.floor(yb / 4375)
      const ymb = yb % 4375
      const ymd = Math.floor(ymb / 144)
      const ymdb = ymb % 144
      const th = Math.floor(ymdb / 6)
      const thb = ymdb % 6
      const tm = thb * 10
      const blocktime = `${String(th).padStart(2,'0')}:${String(tm).padStart(2,'0')} ${String(ymd+1).padStart(2,'0')}/${String(ym+1).padStart(2,'0')}/${String(y+1).padStart(4,'0')} BTC`
      const minihash = hash.slice(-4)
      const template = opts.message
      const message = template
        .replaceAll('{domain}', domain)
        .replaceAll('{blocktime}', blocktime)
        .replaceAll('{minihash}', minihash)
      //const message = `I hereby request access to ${domain} at ${time} (${hash.slice(-4)}) subject to the terms and policies then on file.`

      // show modified login page
      if (JSON.stringify(Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'signerror'))) == '{}') {
        let content = fs.readFileSync(path.join(__dirname, 'login-page.html'), 'utf8')
        let messageSnippet = fs.readFileSync(path.join(__dirname, 'error-snippet.html'), 'utf8')
        content = content.replaceAll('{base_url}', `${proto}://${domain}`)
        content = content.replaceAll('{message}', message)
        content = content.replaceAll('{error_slot}', (!req.query.signerror)?'':messageSnippet.replaceAll('{message}', req.query.signerror))
        res.send(content)
        res.end()
      } else if (JSON.stringify(Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'signinfo'))) == '{}') {
        let content = fs.readFileSync(path.join(__dirname, 'login-page.html'), 'utf8')
        let messageSnippet = fs.readFileSync(path.join(__dirname, 'info-snippet.html'), 'utf8')
        content = content.replaceAll('{base_url}', `${proto}://${domain}`)
        content = content.replaceAll('{message}', message)
        content = content.replaceAll('{error_slot}', (!req.query.signinfo)?'':messageSnippet.replaceAll('{message}', req.query.signinfo))
        res.send(content)
        res.end()
      } else {

        // perform modified login procedure
        const loginMessage = req.query.loginMessage
        const loginId      = req.query.loginId
        const loginSig     = req.query.loginSig
        if (loginMessage != message) {
          console.log(`failed login by ${loginId}`)
          console.log(`presented: ${loginMessage}`)
          console.log(`expected: ${message}`)
          res.redirect(`${opts.route}?signerror=Login+message+expired:+try+again.`)
        } else {
          verify(loginId, loginMessage, loginSig).then(match => {
            console.log(`received ${match.scheme} by ${match.loginId}`)
            const date_now = Date.now()
            const prevTemplate = activity.data.reduce((a, c) => {
              let age = date_now - c.date
              if (['success', 'new-terms'].includes(c.status) && !isNaN(c.date) && c.template && (!a.age || age < a.age)) {
                return { age, template: c.template }
              } else {
                return a
              }
            }, { age: 0, template: '' }).template
            const prevTemplateFilled = prevTemplate
              .replaceAll('{domain}', domain)
              .replaceAll('{blocktime}', blocktime)
              .replaceAll('{minihash}', minihash)
            if (false) { // if (prevTemplateFilled != message) {
              console.log(`terms changed for ${loginId}`)
              console.log(`old: ${prevTemplateFilled}`)
              console.log(`new: ${message}`)
              res.redirect(`${opts.route}?signinfo=The+sign-in+message+has+changed+since+you+last+signed+in.+Please+re-read+it+carefully+before+proceeding.`)
              activity.data.push({
                date: Date.now(),
                status: 'new-terms',
                presented: loginId,
                scheme: match.scheme,
                id: match.loginId,
                message: match.message,
                template: template,
                sig: match.sig
              })
              activity.write().then(()=>{}).catch(e => console.log(`error writing db: ${e}`))
            } else {
            let screenUser = new Promise((resolve, reject) => {
              resolve()
            })
/*
            if (match.scheme == 'Bitcoin Signed Message') {
              screenUser = new Promise((resolve, reject) => {
                fetch(`${opts.mempool}/api/address/${loginId}/txs`).then(r => r.json()).then(json => {
                  txs = json
                  if (txs.length == 0) {
                    reject('Bitcoin address not found on blockchain: use another.')
                  } else {
                    resolve()
                  }
                })
              })
            }
*/
            screenUser.then(() => {
              loginMattermost(res, match.loginId).then(detail => {
                console.log(`successful login by ${match.loginId}`)
                res.redirect('/')
                activity.data.push({
                  date: Date.now(),
                  status: 'success',
                  presented: loginId,
                  scheme: match.scheme,
                  id: match.loginId,
                  message: match.message,
                  template: template,
                  sig: match.sig,
                  user: detail.id
                })
                activity.write().then(()=>{}).catch(e => console.log(`error writing db: ${e}`))
              }).catch(e => {
                console.log(`failed to login ${match.loginId}: ${e}`)
                res.redirect(`${opts.route}?signerror=${encodeURIComponent('Unexpected error: please report date/time of incident to admin.')}`)
              })
            }).catch(e => {
              console.log(`blocked ${match.loginId}: ${e}`)
              activity.data.push({
                date: Date.now(),
                status: 'blocked',
                presented: loginId,
                scheme: match.scheme,
                id: match.loginId,
                message: match.message,
                template: template,
                sig: match.sig,
              })
              activity.write().then(()=>{}).catch(e => console.log(`error writing db: ${e}`))
              res.redirect(`${opts.route}?signerror=${encodeURIComponent(e)}`)
            })
            }
          }).catch(e => {
            console.log(`signature verification failed for ${loginId}: ${e}`)
            res.redirect(`${opts.route}?signerror=${encodeURIComponent('Improperly signed: try again.')}`)
          })
        }
      }
    })
  })
})


// intended as admin panel behind umbrel login
app.get(`${opts.admin}`, function (req, res) {

  const proto = req.protocol
  const domain = req.get('host')

  // tablulate results
  let users = undefined
  const getResults = () => {
    let rows = Object.getOwnPropertyNames(db.data).map(id => {
      const latest = activity.data.reduce((a,c) => {
        if (c.id == id && c.status == 'success') {
          if (a.scheme == '' || a.time < c.time) {
            return c
          } else {
            return a
          }
        } else {
          return a
        }
      }, { scheme: '', time: '' })
      const u = users?.filter(u => u.id == db.data[id])[0]
      const username = u?.username||'('+db.data[id]+')'
      const firstlast = u? [u.last_name, u.first_name].filter(n => n).join(', '): ''
      const displayname = u? (u.nickname+' '+(firstlast? '('+firstlast+')': '')).trim(): ''
      return `<td>${username}</td><td>${displayname}</td><td>${latest.scheme.replace(' Signed Message','')}</td><td>${latest.presented||id}</td>`
    })
    let table = '<table class="guests"><tr><th>Username</th><th>Name</th><th>Auth</th><th>Identification</th></tr><tr>'+rows.join('</tr><tr>')+'</tr></table>'

    const absPath = path.join(__dirname, 'admin-page.html')
    let content = fs.readFileSync(absPath, 'utf8')
    content = content.replaceAll('{base_url}', `${proto}://${domain}`)
    content = content.replaceAll('{table}', table)
    res.send(content)
    res.end()
  }

  // get user details
  const queryUsers = () => {
    fetch(`${opts.mattermost}/api/v4/users?inactive&in_team=${team_id}`, get_options)
    .then(r => r.json()).then(json => {
      users = json
      getResults()
    }).catch(e => {
      console.log(`user query failed: ${e}`)
      getResults()
    })
  }

  // find welcome team
  if (!team_id) {
    fetch(`${opts.mattermost}/api/v4/teams/name/welcome`, get_options).then(r => r.json()).then(json => {
      if (json.name == 'welcome' && json.id) {
        team_id = json.id
        queryUsers()
      } else {
        console.log(`error finding welcome team: ${JSON.stringify(json)}`)
        getResults()
      }
    })
  } else {
    queryUsers()
  }
})


// handles ancillary files (styles, etc.) when serving for a local umbrel instance
app.get('/:path*', (req, res) => {
  if (req.get('host').endsWith(':8766')) {
    res.redirect(`${req.protocol}://${req.hostname}:8765${req.originalUrl}`)
  } else {
    res.end();
  }
});



var http = require('http')
const port = +opts.port
http.createServer(app_options, app).listen(port)
console.log(`node ${process.version}`)
console.log(`listening on port ${port}`)

})
})

