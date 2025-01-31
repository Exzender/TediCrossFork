import R from "ramda";
import middlewares from "./middlewares";
import { sleep } from "../sleep";
import { Telegraf } from "telegraf";
import { Logger } from "../Logger";
import { Client } from "discord.js";
import { MessageMap } from "../MessageMap";
import { BridgeMap } from "../bridgestuff/BridgeMap";
import { Settings } from "../settings/Settings";
import {
	chatinfo,
	threadinfo,
	handleEdits,
	leftChatMember,
	newChatMembers,
	relayMessage,
	TediCrossContext,
	channelChatInfo
} from "./endwares";
import { BotCommand, ChatAdministratorRights } from "telegraf/types";

/***********
 * Helpers *
 ***********/

/**
 * Clears old messages on a tgBot, making sure there are no updates in the queue
 *
 * @param tgBot	The Telegram bot to clear messages on
 * @param offset	The Telegram messages offset
 *
 * @returns Promise resolving to nothing when the clearing is done
 */
function clearOldMessages(tgBot: Telegraf, offset = -1): Promise<void> {
	const timeout = 0;
	const limit = 100;
	return tgBot.telegram
		.getUpdates(timeout, limit, offset, [])
		.then(
			R.ifElse(
				R.isEmpty,
				R.always(undefined),
				R.compose<any, any>(
					newOffset => clearOldMessages(tgBot, newOffset),
					//@ts-ignore
					R.add(1),
					R.prop("update_id"),
					R.last
				)
			)
		)
		.then(() => undefined);
}

/**********************
 * The setup function *
 **********************/

export interface TediTelegraf extends Telegraf {
	use: any | TediCrossContext;
	// eslint-disable-next-line
	on: any | ((value: string) => TediCrossContext);
	context: TediCrossContext;
}

/**
 * Sets up the receiving of Telegram messages, and relaying them to Discord
 *
 * @param logger The Logger instance to log messages to
 * @param tgBot The Telegram bot
 * @param dcBot The Discord bot
 * @param messageMap Map between IDs of messages
 * @param bridgeMap Map of the bridges to use
 * @param settings The settings to use
 */
export function setup(
	logger: Logger,
	tgBot: TediTelegraf,
	dcBot: Client,
	messageMap: MessageMap,
	bridgeMap: BridgeMap,
	settings: Settings
) {
	settings.on("bridgeUpdate", newBridgeMap => {
		// console.log("Got bridgeUpdate event in TG bot");
		tgBot.context.TediCross.bridgeMap = newBridgeMap;
	});

	//@ts-ignore
	tgBot.ready = Promise.all([
		// Get info about the bot
		tgBot.telegram.getMe(),
		// Clear old messages, if wanted. XXX Sleep 1 sec if not wanted. See issue #156
		settings.telegram.skipOldMessages ? clearOldMessages(tgBot) : sleep(1000)
	])
		.then(([me]) => {
			// Log the bot's info
			logger.info(`Telegram: ${me.username} (${me.id})`);

			const myCommands: BotCommand[] = [
				{
					command: "chatinfo",
					description: "Get info about the chat"
				},
				{
					command: "threadinfo",
					description: "Get info about the thread"
				}
			];

			// Set the commands
			tgBot.telegram.setMyCommands(myCommands, { scope: { type: "default" } }).then(() => {
				// wait 5 seconds to make sure the commands are set
				setTimeout(() => {
					tgBot.telegram.getMyCommands().then((commands: BotCommand[]) => {
						logger.info("Telegram commands:", commands);
						if (commands.length < 2) {
							throw new Error("Telegram: Expected 2 commands, got " + commands.length);
						}
					});
				}, 5000);
			});

			const defaultPermissions: ChatAdministratorRights = {
				can_manage_chat: true,
				can_delete_messages: true,
				can_change_info: true,
				can_invite_users: true,
				can_post_messages: true,
				can_edit_messages: true,
				can_pin_messages: true,
				can_manage_topics: true,
				is_anonymous: false,
				can_manage_video_chats: false,
				can_restrict_members: false,
				can_promote_members: false
			};

			// Set default admin permissions for groups and super groups
			tgBot.telegram
				.setMyDefaultAdministratorRights({
					rights: defaultPermissions,
					forChannels: false
				})
				.then();

			// Set default admin permissions for channel
			tgBot.telegram
				.setMyDefaultAdministratorRights({
					rights: defaultPermissions,
					forChannels: true
				})
				.then();

			// Set keeping track of where the "This is an instance of TediCross..." has been sent the last minute
			const antiInfoSpamSet = new Set();

			const groupIdMap: Map<string, TediCrossContext[]> = new Map();

			// Add some global context
			tgBot.context.TediCross = {
				me,
				bridgeMap,
				dcBot,
				settings,
				messageMap,
				logger,
				antiInfoSpamSet,
				groupIdMap
			};

			// Apply middlewares and endwares
			tgBot.command("chatinfo", chatinfo);
			tgBot.command("threadinfo", threadinfo);
			tgBot.use(channelChatInfo as any);
			tgBot.use(middlewares.addTediCrossObj);
			tgBot.use(middlewares.addMessageObj);
			tgBot.use(middlewares.addMessageId);
			tgBot.use(middlewares.addBridgesToContext);
			tgBot.use(middlewares.informThisIsPrivateBot);
			tgBot.use(middlewares.removeD2TBridges);
			//@ts-ignore telegram expacts a second parameter
			//tgBot.command(middlewares.removeBridgesIgnoringCommands);
			tgBot.on("new_chat_members", middlewares.removeBridgesIgnoringJoinMessages);
			tgBot.on("left_chat_member", middlewares.removeBridgesIgnoringLeaveMessages);
			tgBot.on("new_chat_members", newChatMembers);
			tgBot.on("left_chat_member", leftChatMember);
			tgBot.use(middlewares.addFromObj);
			tgBot.use(middlewares.addReplyObj);
			tgBot.use(middlewares.addForwardFrom);
			tgBot.use(middlewares.addTextObj);
			tgBot.use(middlewares.addFileObj);
			tgBot.use(middlewares.addFileLink);
			tgBot.use(middlewares.addPreparedObj);

			// Apply endwares
			tgBot.on(["edited_message", "edited_channel_post"], handleEdits);
			tgBot.use(relayMessage as any);

			// Don't crash on errors
			tgBot.catch((err: any) => {
				// The docs says timeout errors should always be rethrown
				// @ts-ignore TODO: Telefraf does not exprt the TimoutError, alternative implementation needed

				// Log other errors, but don't do anything with them
				logger.error(err);
			});
		})
		// Start getting updates
		//@ts-ignore TODO: startPooling is a private method. Maybe use .launch() instead
		.then(() => tgBot.startPolling());
}
