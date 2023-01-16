import { Boom } from '@hapi/boom'
import makeWASocket, {
	AnyMessageContent,
	delay,
	DisconnectReason,
	fetchLatestBaileysVersion,
	isJidBroadcast,
	Label,
	makeCacheableSignalKeyStore,
	makeInMemoryStore,
	MessageRetryMap,
	useMultiFileAuthState
} from '../src'
import MAIN_LOGGER from '../src/Utils/logger'

const logger = MAIN_LOGGER.child({ })
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterMap: MessageRetryMap = { }

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: true,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterMap,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries
		getMessage: async key => {
			if(store) {
				const msg = await store.loadMessage(key.remoteJid!, key.id!)
				return msg?.message || undefined
			}

			// only if store is present
			return {
				conversation: 'hello'
			}
		}
	})

	store?.bind(sock.ev)

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
					}
				}

				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest } = events['messaging-history.set']
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`)
			}

			// received a new message
			if(events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if(upsert.type === 'notify') {
					for(const msg of upsert.messages) {
						const chatId = msg.key.remoteJid!
						if(!msg.key.fromMe && doReplies) {
							console.log('replying to', chatId)
							await sock!.readMessages([msg.key])
							await sendMessageWTyping({ text: 'Hello there!' }, chatId)
						}

						if((msg.key.fromMe) && (msg?.message?.conversation)) {
							const nostore = 'Store is absent'
							const text: string = msg.message.conversation
							console.log('COMMAND', text)
							const words: string[] = text.trim().split(' ')
							const command = words[0] ?? ''
							const tail = words.length > 1 ? words.slice(1).join(' ') : ''
							let labelIds = tail ? tail.split(',') : []
							if(labelIds) {
								labelIds = labelIds.map(labelId => labelId.trim())
							}

							let reply = ''
							switch (command) {
								case 'labels':
									reply = store?.getLabels ? JSON.stringify(store.getLabels()) : nostore

									break
								case 'labelIds':
									reply = store?.getLabelIds ? JSON.stringify(store.getLabelIds()) : nostore

									break
								case 'chatLabelIds':
									reply = store?.getChatLabelIds ? JSON.stringify(store.getChatLabelIds(chatId)) : nostore

									break
								case 'chatLabels':
									reply = store?.getChatLabels ? JSON.stringify(store.getChatLabels(chatId)) : nostore

									break
								case 'setChatLabelIds':
									reply = store?.setChatLabelIds ? JSON.stringify(store.setChatLabelIds(chatId, labelIds, sock)) : nostore

									break
								case 'addChatLabelIds':
									reply = store?.addChatLabelIds ? JSON.stringify(store.addChatLabelIds(chatId, labelIds, sock)) : nostore

									break
								case 'delChatLabelIds':
									reply = store?.delChatLabelIds ? JSON.stringify(store.delChatLabelIds(chatId, labelIds, sock)) : nostore

									break
								case 'delAllChatLabelIds':
									reply = store?.delChatLabelIds ? JSON.stringify(store.delChatLabelIds(chatId, true, sock)) : nostore

									break
							}

							if(reply) {
								const content = { text: 'REPLY on COMMAND ' + text + '\n' + reply }
								console.log('REPLY', content)
								await sock.sendMessage(chatId, content)
							}
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				console.log(events['messages.update'])
			}

			if(events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if(events['presence.update']) {
				console.log(events['presence.update'])
			}

			if(events['chats.update']) {
				console.log(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if(events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock
}

startSock()
