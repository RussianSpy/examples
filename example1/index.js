class YoutubeController {
	static async addChannel(ctx) {
		// Must be set url or id
		if(!ctx.request.body.url && !ctx.request.body.youtubeChannelId) {
			ctx.body = { error: 'No channel URL or channel id' };
			return;
		}

		// Checking URL
		if(ctx.request.body.url) {
			if(!youtube.checkURL(ctx.request.body.url)) {
				ctx.body = { error: 'Channel URL is not correct' };
				return;
			}

			var youtubeChannelId = youtube.getChannelId(ctx.request.body.url);

			if(!youtubeChannelId) {
				ctx.body = { error: 'Channel id not found in the URL' };
				return;
			}
		}

		// Checking channel id
		if(ctx.request.body.youtubeChannelId) {
			if(!youtube.checkChannelId(ctx.request.body.youtubeChannelId)) {
				ctx.body = { error: 'Channel Id is not correct' };
				return;
			}

			var youtubeChannelId = ctx.request.body.youtubeChannelId;
		}

		let result = {};
		let isNewChannel = true;

		// Duplicates are not allowed
		let duplicates = await db.getChannelByYoutubeId(youtubeChannelId);

		if(duplicates && duplicates.length) {
			// Duplicates only if channel is active
			if(duplicates[0].isactive === true) {
				ctx.body = { error: 'This channel already exists in the system' };
				return;
			}

			// If channel is not active - just turn it on
			await db.setChannelActive(duplicates[0].channel_id);

			isNewChannel = false;

			result = {channel_id: duplicates[0].channel_id, youtube_channel_id: youtubeChannelId};
		}
		else {
			let data = {
				user_id: ctx.session.user.userid,
				youtubeChannelId: youtubeChannelId
			};

			let channelResult = await db.addChannel(data);

			if(channelResult && channelResult.length){
				result = {channel_id: channelResult[0].channel_id, youtube_channel_id: youtubeChannelId};
			}
		}

		const reloadResult = await youtube.reloadChannelData(result.channel_id, result.youtube_channel_id);

		if(reloadResult.error) {
			ctx.body = reloadResult;
			return;
		}

		if(isNewChannel) {
			await db.setChannelActive(result.channel_id);
		}

		result.videos = reloadResult.videos;

		ctx.body = result;
	}

	static async getChannelById(ctx) {
		let channelId = ctx.data.id || 0;

		const result = await db.getChannelById(channelId);

		if(!result || !result.length){
			ctx.body = { error: 'Channel not found' };
			return;
		}

		const item = result[0];

		let channel = {
				channelId: item.channel_id,
				title: item.channel_title,
				description: item.channel_description,
				youtubeChannelId: item.youtube_channel_id,
				thumbnails: youtube.parseJSON(item.thumbnails),
				videos: item.videos,
				views: item.views,
				subscribers: item.subscribers,
				comments: item.comments,
				created: item.created,
				lang: item.lang,
				updated: item.updated
		};

		ctx.body = channel;
	}
}

module.exports = YoutubeController;