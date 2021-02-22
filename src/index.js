const fs = require('fs')
const promiseTimeout = require('promise-timeout').timeout
const sleep = require('sleep-promise')
const fetch = require('node-fetch')
const homoglyphSearch = require('homoglyph-search').search
const Discord = require('discord.js')
const client = new Discord.Client()

const prices = require('./prices.js')
const config = require('../config.json')

console.error('-- starting up at ' + new Date())
console.log('-- starting up at ' + new Date())

let muted = {}

try {
  muted = JSON.parse(fs.readFileSync('muted.json'))
} catch (err) {
  console.error('Failed to read muted data:')
  console.error(err)
}

let mutedWriting = false
let mutedWriteScheduled = false

function saveMuted() {
  if (mutedWriting) {
    mutedWriteScheduled = true
    return
  }
  mutedWriting = true
  const mutedJson = {}
  for (let key of Object.keys(muted)) {
    mutedJson[key] = {
      endsAt: muted[key].endsAt,
    }
  }
  fs.writeFile('muted.json', JSON.stringify(mutedJson), () => {
    if (mutedWriteScheduled) {
      mutedWriteScheduled = false
      saveMuted()
    } else {
      mutedWriting = false
    }
  })
}
saveMuted()

function modifyRole(role, users, addRole) {
  let promises = []
  for (let member of users) {
    if (!config.testing) {
      // don't mute mods or bots
      if (member.user.id === client.user.id) {
        return
      }
      if (member.user.bot) {
        return
      }
      if (member.roles.cache.some((r) => config.modRoles.includes(r.name))) {
        continue
      }
    }
    let promise
    if (addRole) {
      promise = member.roles.add(role)
    } else {
      promise = member.roles.remove(role)
    }
    promises.push(
      promise
        .then(() => [member, false])
        .catch((err) => {
          console.error(err)
          return [member, true]
        }),
    )
  }
  return Promise.all(promises).then((arr) => ({
    successful: arr.filter((x) => !x[1]).map((x) => x[0]),
    errored: arr.filter((x) => x[1]).map((x) => x[0]),
  }))
}

async function removeRoleSafe(member, role) {
  while (true) {
    try {
      await member.roles.remove(role)
      break
    } catch (err) {
      if (!err.code || (err.code >= 10000 && err.code <= 10000)) {
        // They're not in the server right now.
        // When they rejoin they won't have the role.
        break
      }
      console.error(err)
      await sleep(5000)
    }
  }
}

function findFirstNum(parts) {
  for (let part of parts) {
    if (!isNaN(part)) {
      return part
    }
  }
}

async function messageLinkBlacklisted(message) {
  const longLinkRegex = /reddit.com[\/\\]r[\/\\]cryptocurrency/i
  if (longLinkRegex.test(message)) {
    return true
  }
  const shortLinkRegex = /(reddit.com|redd.it)[\/\\]([a-z0-9]{6})/gi
  while ((shortLinkInfo = shortLinkRegex.exec(message)) !== null) {
    const shortLink = 'https://www.reddit.com/' + shortLinkInfo[2]
    let res = await fetch(shortLink, { redirect: 'manual' })
    if (longLinkRegex.test(res.headers.get('location'))) {
      return true
    }
  }
  return false
}

const unauthorizedPingers = {}

client.on('message', async (msg) => {
  try {
    let isMod =
      msg.guild &&
      msg.guild.available &&
      msg.member &&
      msg.member.roles.cache.some((r) => config.modRoles.includes(r.name))
    if (isMod) {
      for (let user of msg.mentions.users.array()) {
        if (!user || !user.id) continue
        await client.users.fetch(user.id)
        await msg.guild.members.fetch(user)
      }
    }
    if (
      msg.content.trim().startsWith('!') ||
      (msg.mentions && msg.mentions.users && msg.mentions.users.array().length)
    ) {
      console.log('<@' + msg.author.id + '>: ' + msg.content)
    }
    if (msg.channel instanceof Discord.TextChannel) {
      if (await messageLinkBlacklisted(msg.content)) {
        await msg.delete()
        await msg.reply(
          'Sorry, but links to r/cc are blacklisted' +
            ' as per their vote manipulation policy.\nAttempts to bypass this' +
            ' do not look good on the community and will result in a mute.',
        )
        return
      }
      if (
        !isMod &&
        !msg.author.bot &&
        msg.member &&
        msg.member.roles.cache.some((r) =>
          config.noPingingRoles.includes(r.name),
        ) &&
        msg.mentions.users.array().length
      ) {
        await msg.delete()
        const authorId = msg.author.id
        const now = Date.now()
        const timeout = 5 * 60 * 1000
        if (now - (unauthorizedPingers[authorId] || 0) < timeout) {
          await msg.member.kick()
          await msg.channel.send(
            '<@' + msg.author.id + '> has been kicked for pinging while muted.',
          )
        } else {
          await msg.reply(
            "No pinging when you're muted! Doing it again will get you kicked.",
          )
        }
        unauthorizedPingers[authorId] = now
        setTimeout(() => {
          if (unauthorizedPingers[authorId] === now) {
            delete unauthorizedPingers[authorId]
          }
        }, timeout)
      }
    }
    const parts = msg.content.split(' ')
    if (parts[0] === '!mute') {
      if (!isMod) {
        return
      }
      const durationStr = findFirstNum(parts)
      let duration = parseFloat(durationStr)
      if (!duration) {
        return
      }
      const sinbinRole = msg.guild.roles.cache.find(
        (r) => r.name === config.sinbinRole,
      )
      if (!sinbinRole) return
      if (!duration || duration <= 0) return
      duration = duration * 60 * 1000
      if (!msg.mentions.members) return
      const { successful, errored } = await modifyRole(
        sinbinRole,
        msg.mentions.members.array(),
        true,
      )
      if (!successful.length && !errored.length) {
        return
      }
      for (let member of successful) {
        // member.id might change if the user leaves then re-joins
        let permanentId = msg.guild.id + ' ' + member.user.id
        if (muted[permanentId] !== undefined) {
          clearTimeout(muted[permanentId].timeout)
        }
        const timeout = setTimeout(async () => {
          removeRoleSafe(member, sinbinRole)
          delete muted[permanentId]
          saveMuted()
        }, duration)
        muted[permanentId] = {
          timeout,
          endsAt: Date.now() + duration,
        }
      }
      saveMuted()
      let message = ''
      if (successful.length) {
        message += 'Muted '
        message += successful.map((x) => '<@' + x.id + '>').join(', ')
        if (parseFloat(parts[1]) === 1) {
          message += ' for 1 minute.'
        } else {
          message += ' for ' + durationStr + ' minutes.'
        }
        message += ' Please follow the <#' + config.rulesChannelId + '>.'
      }
      if (errored.length) {
        message += 'Failed to mute '
        message += errored.map((x) => '<@' + x.id + '>').join(', ')
        message += '. <@' + config.ownerId + '> check logs and investigate.'
      }
      msg.channel.send(message)
    } else if (parts[0] === '!unmute') {
      if (!isMod) {
        return
      }
      const sinbinRole = msg.guild.roles.cache.find(
        (r) => r.name === config.sinbinRole,
      )
      if (!sinbinRole) return
      if (!msg.mentions.members) return
      const { successful, errored } = await modifyRole(
        sinbinRole,
        msg.mentions.members.array(),
        false,
      )
      if (!successful.length && !errored.length) {
        return
      }
      for (let member of successful) {
        let permanentId = msg.guild.id + ' ' + member.user.id
        if (muted[permanentId] !== undefined) {
          const mutedInfo = muted[permanentId]
          clearTimeout(mutedInfo.timeout)
          delete muted[permanentId]
        }
      }
      saveMuted()
      let message = ''
      if (successful.length) {
        message += 'Unmuted '
        message += successful.map((x) => '<@' + x.id + '>').join(', ')
        message += '. '
      }
      if (errored.length) {
        message += 'Failed to unmute '
        message += errored.map((x) => '<@' + x.id + '>').join(', ')
        message += '. <@' + config.ownerId + '> check logs and investigate.'
      }
      msg.channel.send(message)
    } else if (parts[0] === '!getroleid') {
      if (!isMod) {
        return
      }
      const role = msg.guild.roles.cache.find(
        (r) => r.name === parts.slice(1).join(' '),
      )
      if (role) {
        msg.reply('role id: ' + role.id)
      } else {
        msg.reply('role not found')
      }
    } else if (
      parts[0].startsWith('!disable') ||
      parts[0].startsWith('!enable')
    ) {
      if (!isMod) {
        return
      }
      let newRoleValue
      let roleName
      if (parts[0].startsWith('!enable')) {
        newRoleValue = true
        roleName = parts[0].slice('!enable'.length) || parts[1]
      } else if (parts[0].startsWith('!disable')) {
        newRoleValue = false
        roleName = parts[0].slice('!disable'.length) || parts[1]
      } else {
        throw new Error('Error parsing mod role setting command')
      }
      const modConfiguredRoles = config.modConfiguredRoles || {}
      if (!modConfiguredRoles.hasOwnProperty(roleName)) return
      const roleConf = modConfiguredRoles[roleName]
      const role = msg.guild.roles.cache.get(roleConf.id)
      if (!role || !msg.mentions.members) return
      const { successful, errored } = await modifyRole(
        role,
        msg.mentions.members.array(),
        !!(newRoleValue ^ !!roleConf.inverted),
      )
      if (!successful.length && !errored.length) {
        return
      }
      let message = ''
      if (successful.length) {
        message +=
          (newRoleValue ? 'Enabled ' : 'Disabled ') +
          (roleConf.name || roleName) +
          ' for '
        message += successful.map((x) => '<@' + x.id + '>').join(', ')
        message += '.'
      }
      if (errored.length) {
        message +=
          'Failed to ' +
          (newRoleValue ? 'enable ' : 'disable ') +
          (roleConf.name || roleName) +
          ' for '
        message += errored.map((x) => '<@' + x.id + '>').join(', ')
        message += '. <@' + config.ownerId + '> check logs and investigate.'
      }
      msg.channel.send(message)
    }
  } catch (err) {
    console.error(err)
  }
})

let copycatTargets = []
let copycatTargetDiscriminators = {}
let copycatTargetIds = new Set()
let copycatWords = []

function preprocessCopycatName(name) {
  return name.replace(/\s/g, '')
}

function isCopycat(name, discriminator) {
  if (copycatTargets.length === 0 || !name) {
    return false
  }
  name = preprocessCopycatName(name)
  let lengthMatches = copycatWords.slice()
  let symbolCount = 0
  for (let char of name) {
    symbolCount++
  }
  for (let copycatTarget of copycatTargets) {
    if (Math.abs(symbolCount - copycatTarget.length) <= 2) {
      lengthMatches.push(copycatTarget)
    }
  }
  let matchLevel = 0
  for (let match of homoglyphSearch(name, lengthMatches)) {
    matchLevel = Math.max(matchLevel, 1)
    if (
      discriminator &&
      copycatTargetDiscriminators[match.word] === discriminator
    ) {
      matchLevel = Math.max(matchLevel, 2)
    }
  }
  return matchLevel
}

function checkForCopycat(user, name) {
  let copycatLevel = isCopycat(name, user.discriminator)
  if (copycatLevel > 0 && !copycatTargetIds.has(user.id)) {
    let message =
      '^^ <@&' + config.copycatAlertRoleId + '> potential impersonator'
    if (copycatLevel > 1) {
      message += '\nsince discriminator matches, may be a ban in the future'
    }
    client.channels.cache.get(config.nameChangeChannelId).send(message)
  }
}

client.on('userUpdate', (oldUser, newUser) => {
  let noticeablyChanged = false
  if (oldUser.username !== newUser.username) {
    let message =
      '`' +
      oldUser.username +
      '` has changed their username to `' +
      newUser.username +
      '`: <@' +
      newUser.id +
      '>'
    client.channels.cache.get(config.nameChangeChannelId).send(message)
    noticeablyChanged = true
  }
  if (oldUser.discriminator !== newUser.discriminator) {
    let message =
      '`' +
      newUser.username +
      '` has changed their discriminator from #' +
      oldUser.discriminator +
      ' to #' +
      newUser.discriminator +
      ': <@' +
      newUser.id +
      '>'
    client.channels.cache.get(config.nameChangeChannelId).send(message)
    noticeablyChanged = true
  }
  if (noticeablyChanged) {
    checkForCopycat(newUser, newUser.username)
  }
})

client.on('guildMemberUpdate', (oldMember, newMember) => {
  let oldNick = oldMember.nickname || oldMember.user.username
  let newNick = newMember.nickname || newMember.user.username
  if (oldNick != newNick) {
    let message =
      '`' +
      oldNick +
      '` has changed their nickname to `' +
      newNick +
      '`: <@' +
      newMember.user.id +
      '>'
    client.channels.cache.get(config.nameChangeChannelId).send(message)
    checkForCopycat(newMember.user, newNick)
  }
})

client.on('guildMemberAdd', async (member) => {
  try {
    checkForCopycat(member.user, member.user.username)
    // Is this possible? It can't hurt.
    if (member.nickname) {
      checkForCopycat(member.user, member.nickname)
    }
  } catch (err) {
    console.error(err)
  }
  try {
    let permanentId = member.guild.id + ' ' + member.user.id
    console.log(
      new Date() +
        ' User `' +
        member.user.username +
        '` joined: ' +
        permanentId,
    )
    if (muted[permanentId] !== undefined) {
      const mutedInfo = muted[permanentId]
      clearTimeout(mutedInfo.timeout)
      const duration = mutedInfo.endsAt - Date.now()
      if (duration && duration >= 0) {
        console.log('User has an unexpired mute, applying..')
        const sinbinRole = member.guild.roles.cache.find(
          (r) => r.name === config.sinbinRole,
        )
        if (!sinbinRole) return
        try {
          await member.roles.add(sinbinRole)
        } catch (err) {
          console.error(err)
          setTimeout(
            () => member.roles.add(sinbinRole).catch(console.error),
            1000,
          )
          setTimeout(
            () => member.roles.add(sinbinRole).catch(console.error),
            5000,
          )
        }
        mutedInfo.timeout = setTimeout(() => {
          removeRoleSafe(member, sinbinRole)
          delete muted[permanentId]
          saveMuted()
        }, duration)
      } else {
        delete muted[permanentId]
        saveMuted()
      }
    }
  } catch (err) {
    console.error(err)
  }

  try {
    if (config.welcomeMessage && !member.user.bot) {
      let message = 'Welcome <@' + member.user.id + '> to ' + member.guild.name
      if (config.welcomeMessage) {
        message += ':\n' + config.welcomeMessage
      }
      await member.user.send(message)
    }
  } catch (err) {
    console.error(err)
  }
})

if (config.welcomeMessageFile) {
  config.welcomeMessage = fs.readFileSync(config.welcomeMessageFile)
}

client.login(config.token).then(async () => {
  try {
    // fetch all roles and put them in the cache
    await client.guilds.resolve(config.guildId).roles.fetch()
    if (config.nameChangeChannelId) {
      await client.channels
        .fetch(config.nameChangeChannelId)
        .catch((e) =>
          console.error('Failed to resolve name change channel:', e),
        )
    }
    const mutedToDelete = []
    for (const [permanentId, mutedInfo] of Object.entries(muted)) {
      const [guildId, userId] = permanentId.split(' ')
      const guild = client.guilds.resolve(guildId)
      if (!guild || !guild.available) continue
      const sinbinRole = guild.roles.cache.find(
        (r) => r.name === config.sinbinRole,
      )
      if (!sinbinRole) continue
      const member = await guild.members.fetch(userId).catch(console.error)
      if (!member) continue
      const duration = mutedInfo.endsAt - Date.now()
      if (duration && duration >= 0) {
        mutedInfo.timeout = setTimeout(() => {
          removeRoleSafe(member, sinbinRole)
          delete muted[permanentId]
          saveMuted()
        }, duration)
      } else {
        removeRoleSafe(member, sinbinRole)
        mutedToDelete.push(guildId + ' ' + userId)
      }
    }
    for (const key of mutedToDelete) {
      delete muted[key]
    }
    if (
      config.guildId &&
      (config.copycatTargetRoleIds || config.copycatTargetRoleId)
    ) {
      const guild = client.guilds.resolve(config.guildId)
      const roles = config.copycatTargetRoleIds || [config.copycatTargetRoleId]
      for (let roleId of roles) {
        const role = guild.roles.cache.get(roleId)
        if (!role) {
          console.error('Failed to resolve copycat role ' + roleId)
          continue
        }
        for (let [memberId, member] of role.members) {
          copycatTargetIds.add(member.user.id)
          for (let name of [member.user.username, member.nickname]) {
            if (!name) continue
            name = preprocessCopycatName(name)
            copycatTargets.push(name)
            copycatTargetDiscriminators[name] = member.user.discriminator
          }
        }
      }
      if (config.copycatWords) {
        copycatWords = config.copycatWords
      }
    }
  } catch (err) {
    console.error(err)
  }
  const priceCheckChannel =
    config.priceChannelId &&
    (await client.channels.fetch(config.priceChannelId).catch(console.error))
  if (priceCheckChannel) {
    setInterval(async () => {
      const [coinGecko, ...exchanges] = await Promise.all([
        await prices.coinGecko(),
        ...Object.keys(prices.exchanges).map((x) =>
          promiseTimeout(
            prices.exchanges[x](),
            config.exchangeApiTimeout || 2500,
          )
            .catch((err) => console.log('Exchange API error: ' + err))
            .then((price) => [x, price]),
        ),
      ])
      const embed = {}
      embed.description =
        `**${coinGecko.btc} BTC - $${coinGecko.usd} USD**\n` +
        `Market cap: $${coinGecko.market_cap} USD (#${coinGecko.cap_rank})\n` +
        `24h volume: $${coinGecko.volume} USD\n1 BTC = $${coinGecko.btcusd} USD`
      if (coinGecko.percent_change_1h < 0) {
        embed.color = 0xed2939 // imperial red
      } else if (coinGecko.percent_change_1h > 0) {
        embed.color = 0x39ff14 // neon green
      }
      embed.description += '\n```\n'
      const nameFieldLength = Math.max(...exchanges.map((x) => x[0].length)) + 1
      for (let [name, price] of exchanges) {
        const nameSpacing = ' '.repeat(nameFieldLength - name.length)
        if (price) {
          embed.description += `${name}:${nameSpacing}${price} BTC\n`
        } else {
          embed.description += `${name}:${nameSpacing}API error\n`
        }
      }
      embed.description += '```'
      embed.footer = {
        text: 'Pulled from CoinGecko and the listed exchanges',
      }
      embed.timestamp = new Date().toISOString()
      await priceCheckChannel.send(new Discord.MessageEmbed(embed))
    }, config.priceInterval || 60000)
  }
})

client.on('error', console.error)
