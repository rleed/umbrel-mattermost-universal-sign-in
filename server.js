const { parseArgs } = require('node:util')
const fs = require('fs')
const path = require('path')
const express = require('express')
const { exec } = require("child_process")
const bm = require('bitcoinjs-message')
const bl = require('bitcoinjs-lib')
const z32 = require('z32')

const options = {
  port: {
    type: 'string',
    short: 'p',
    default: '8066',
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
    short: 'w',
  },
  route: {
    type: 'string',
    short: 'r',
    default: '/sign-in'
  },
  mempool: {
    type: 'string',
    short: 'M',
    default: 'https://mempool.space',
  },
}

const { values: opts, positionals: args } = parseArgs({
  options,
  allowPositionals: true,
})

var app = express()
var app_options = {}


function base64ToBytes(base64) {
  const binString = Buffer.from(base64, 'base64').toString('utf8');
  return Uint8Array.from(binString, (m) => m.codePointAt(0));
}


function loginMattermost(res, domain, id) {
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
        //console.log(`injecting session cookies for ${username}`)
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

    fetch(`${opts.mattermost}/api/v4/users/email/${shortcode}@satoshidnc.com`, get_options).then(r => r.json()).then(json => {
      if (json.status_code == 404) {

        // create new user
        console.log(`creating new user account ${shortcode}`)
        fetch(`${opts.mattermost}/api/v4/users`, { ...post_options, body: JSON.stringify({
          username: shortcode,
          password: opts.password,
          email: `${shortcode}@satoshidnc.com`
        })}).then(r => r.json()).then(json => {
          if (json.email == `${shortcode}@satoshidnc.com` && json.id) {
            user_id = json.id
            // find welcome team
            fetch(`${opts.mattermost}/api/v4/teams/name/welcome`, get_options).then(r => r.json()).then(json => {
              if (json.name == 'welcome' && json.id) {
                team_id = json.id
                // add user to team
                fetch(`${opts.mattermost}/api/v4/teams/${team_id}/members`, { ...post_options, body: JSON.stringify({
                  team_id: team_id,
                  user_id: user_id
                })}).then(r => r.json()).then(json => {
                  if (json.team_id == team_id && json.user_id == user_id) {
                    // log in
                    injectSession(shortcode).then(() => {
                      console.log(`logged in ${shortcode}`)
                      resolve()
                    })
                  } else {
                    reject(`error adding user to team: ${JSON.stringify(json)}`)
                  }
                })
              } else {
                reject(`error finding welcome team: ${JSON.stringify(json)}`)
              }
            })
          } else {
            reject(`error creating account ${shortcode}: ${JSON.stringify(json)}`)
          }
        })

      } else if (json.email == `${shortcode}@satoshidnc.com` && json.id != '') {
        injectSession(json.username).then(() => {
          console.log(`logged in ${shortcode}`)
          resolve()
        })
      } else {
        console.log(`error querying mattermost user ${shortcode}`)
        reject(JSON.stringify(json))
      }
    }).catch(e => { reject(e) })

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
          loginId: pubkey
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
            loginId: id
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

  // establish block time
  const domain = req.get('host')
  fetch(`${opts.mempool}/api/blocks/tip/hash`).then(r => r.text()).then(text => {
    const hash = text
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
      const time = `${String(th).padStart(2,'0')}:${String(tm).padStart(2,'0')} ${String(ymd+1).padStart(2,'0')}/${String(ym+1).padStart(2,'0')}/${String(y+1).padStart(4,'0')} BTC`
      const message = `I hereby request access to ${domain} at ${time} (${hash.slice(-4)}) subject to the then terms and policies.`

      // show modified login page
      if (JSON.stringify(req.query) == '{}') {
        const absPath = path.join(__dirname, 'login-page.html')
        let content = fs.readFileSync(absPath, 'utf8')
        content = content.replaceAll('{domain}', domain)
        content = content.replaceAll('{message}', message)
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
          res.redirect(opts.route)
        } else {
          verify(loginId, loginMessage, loginSig).then(match => {
            console.log(`received ${match.scheme} by ${match.loginId}`)
            let screenUser = new Promise((resolve, reject) => {
              resolve()
            })
            if (match.scheme == 'Bitcoin Signed Message') {
              screenUser = new Promise((resolve, reject) => {
                fetch(`${opts.mempool}/api/address/${loginId}/txs`).then(r => r.json()).then(json => {
                  txs = json
                  if (txs.length == 0) {
                    reject('no history')
                  } else {
                    resolve()
                  }
                })
              })
            }
            screenUser.then(() => {
              loginMattermost(res, domain, match.loginId).then(() => {
                console.log(`successful login by ${match.loginId}`)
                res.redirect('/')
              }).catch(e => {
                console.log(`failed to login ${match.loginId}: ${e}`)
                res.redirect(opts.route)
              })
            }).catch(e => {
              console.log(`blocked ${match.loginId}: ${e}`)
              res.redirect(opts.route)
            })
          }).catch(e => {
            console.log(`signature verification failed for ${loginId}: ${e}`)
            res.redirect(opts.route)
          })
        }
      }
    })
  })
})


var http = require('http')
const port = +opts.port
http.createServer(app_options, app).listen(port)
console.log(`node ${process.version}`)
console.log(`listening on port ${port}`)
