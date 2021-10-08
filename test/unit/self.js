// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: Unlicense

const tape = require('tape')
const pull = require('pull-stream')
const Server = require('scuttle-testbot')

tape('replicates myself', (t) => {
  t.plan(3)

  Server.use({
    name: 'friends',
    init(sbot) {
      return {
        graphStream() {
          return pull.empty()
        },
        hopStream() {
          return pull.empty()
        },
      }
    },
  })
    .use({
      name: 'ebt',
      init(sbot) {
        return {
          request(feed, bool) {
            t.equals(feed, sbot.id, 'request feed is myself')
            t.true(bool, 'bool is true')
            sbot.close((err) => {
              t.error(err, 'close sbot')
              t.end()
            })
          },
          block() {
            t.fail('ebt.block() should not be called')
          },
        }
      },
    })
    .use(require('../..'))
    .call(null, {})
})
