const crypto = require('crypto')
const ssbKeys = require('ssb-keys')

exports.keysFor = function (name) {
  const seed = crypto.createHash('sha256').update(name).digest()
  return ssbKeys.generate(null, seed)
}

exports.follow = function (id) {
  return {
    type: 'contact',
    contact: id,
    following: true,
  }
}

exports.unfollow = function (id) {
  return {
    type: 'contact',
    contact: id,
    following: false,
  }
}

exports.block = function unfollow(id) {
  return {
    type: 'contact',
    contact: id,
    flagged: true,
  }
}

exports.readOnceFromDB = function (sbot) {
  return new Promise((resolve) => {
    var cancel = sbot.post((msg) => {
      cancel()
      resolve(msg)
    }, false)
  })
}

exports.randint = function (max) {
  return ~~(Math.random() * max)
}

exports.randary = function (ary) {
  return ary[exports.randint(ary.length)]
}

exports.randbytes = function (size) {
  return crypto.randomBytes(size)
}
