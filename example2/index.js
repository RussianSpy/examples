const url = require('url');
const moment = require('moment');
const fetch = require('node-fetch');
const db = require('../db/db.js');


class Youtube {
	static async createAutoTags (diff, videos) {
		const exTags = await db.getTagsExceptions();

		for(let i = 0; i < videos.length; i++) {

			// Ignore videos in delete queue
			if(diff.delete.includes(videos[i].youtube_video_id)) continue;

			// Cleaning string. Remove all special characters
			let title = videos[i].video_title.replace(/(?![a-zA-Z0-9а-яА-ЯёЁ]|\s)./g, '');

			let tagsCandidates = title.split(" ");
			let ids = [];

			// Filter tags
			for(let k = 0; k < tagsCandidates.length; k++) {
				let tag = tagsCandidates[k].trim().toLowerCase();
				if(exTags.includes(tag) || !tag.length) continue;

				let tagId = await db.addTagSpecial(tag);

				ids.push(tagId);
			}

			await db.bindTagsBulk(videos[i].youtube_video_id, ids);
		}
	}

	static checkURL(value) {
		const pattern = /[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)?/gi;

		return !!pattern.test(String(value));
	}

	static checkChannelId(value) {
		let pattern = /^([a-zA-Z0-9-_]{3,})$/;

		return !!pattern.test(String(value));
	}

	static checkTag(value) {
		let pattern = /^[a-zA-Zа-яА-ЯёЁ0-9 ]+$/;

		return !!pattern.test(String(value));
	}

	static checkKey(value) {
		let pattern = /^[a-zA-Z0-9-_]+$/;

		return !!pattern.test(String(value));
	}

	static checkNoQuotaError(json) {
		return (json.error.code === 403 && json.error.errors[0].reason === 'quotaExceeded');
	}

	static async fetchChannelInfo (youtubeChannelId, key) {
		while(true) {
			let request = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${youtubeChannelId}&key=${key.code}&maxResults=1`;

			const response = await fetch(request);
			const json = await response.json();

			// In case of quota exceeded
			if(json.error) {
				let noQuota = this.checkNoQuotaError(json);
				let keyResult = this.changeKey(key, noQuota);

				if(keyResult.error) {
					return keyResult;
				}

				continue;
			}

			return json;
		}
	}

	static async changeKey(key, noQuota) {
		if(noQuota) {
			await db.markKeyExpired({ code: key.code});
		}

		// Choose key from DB
		let keyData = await db.chooseKey({ isWorker: key.isWorker });

		if(!keyData || !keyData.length) {
			return { error: 'No Youtube API keys with enough quota available right now' };
		}

		key.code = keyData[0].key_code;

		return key;
	}

	static async fetchChannelVideos (youtubeChannelId, key) {
		let perPage = 50;
		let keyRenewed = false;

		// To avoid of infinite loop
		let limitCounter = 35;
		let ids = [];
		let lastDate = ''; // To change request to get more items than Youtube's limit

		while(true) {
			let url = `https://www.googleapis.com/youtube/v3/search?key=${key.code}&channelId=${youtubeChannelId}&part=id,snippet&maxResults=${perPage}&type=video&order=date`;

			if(lastDate) {
				// If key was renewed, dont need to calculate time shift
				if(!keyRenewed) {
					lastDate = moment(lastDate).subtract(1, 'seconds').utc().format('YYYY-MM-DDTHH:mm:ss').toString()+"Z";
				}

				url += "&publishedBefore=" + lastDate;
			}

			const response = await fetch(url);
			const json = await response.json();

			// In case of quota exceeded
			if(json.error) {
				let noQuota = this.checkNoQuotaError(json);
				let keyResult = this.changeKey(key, noQuota);

				if(keyResult.error) {
					return keyResult;
				}

				// We renewed key, so we dont need to calculate variable lastDate to get time shift
				keyRenewed = true;
				continue;
			}

			keyRenewed = false;

			json.items.forEach((item) => {
				ids.push(item.id.videoId);
				lastDate = item.snippet.publishedAt;
			});

			// If it was last page
			if(json.items.length < perPage) break;

			// Prevent infinite loop
			limitCounter--;

			if(limitCounter < 1) break;
		}

		// We need only unique ids
		let result = [...new Set(ids)];

		return result;
	}

	static async fetchVideosInfo (videos, key) {

		const result = { items: [] };
		let perPage = 50;
		let steps = Math.ceil(videos.length / perPage);

		for(let i = 0; i < steps; i++) {
			let pos = i * perPage;
			let pcs = videos.slice(pos, pos + perPage);
			let videosIds = pcs.join(',');

			let request = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videosIds}&key=${key.code}`;

			const response = await fetch(request);
			const json = await response.json();

			if(json.error) {
				let noQuota = this.checkNoQuotaError(json);
				let keyResult = this.changeKey(key, noQuota);

				if(keyResult.error) {
					return keyResult;
				}

				i--;

				continue;
			}

			result.items = [].concat(result.items, json.items);
		}

		return result;
	}

	static getChannelId(channelURL) {
		if(!channelURL) return false;

		const parsed = new url.URL(channelURL);

		let path = parsed.pathname.split('/');

		// Looking for markers in path to get channel id
		for(let i = 0; i < path.length; i++) {
			if(path[i].toLowerCase() !== 'channel') continue;

			// If next item doesnt exist
			if(!path[i + 1]) continue;

			// Channel id must match some rules
			if(this.checkChannelId(path[i + 1])) {
				return path[i + 1];
			}
		}

		return false;
	}

	// Sync videos list and videos info in db according to data from youtube services
	static getVideosDataDiff (current, data) {
		let result = { delete: [], update: [], insert: [] };

		// Comparing existing entries with youtube data
		current.forEach((item) => {
			let found = false;

			for(let i = 0; i < data.length; i++) {
				if(item.youtube_video_id === data[i].youtube_video_id) {
					found = true;
					break;
				}
			}

			if(!found){
				result.delete.push(item.youtube_video_id);
			}
			else {
				result.update.push(item.youtube_video_id);
			}
		});

		// Looking for new entries
		data.forEach((item) => {
			let found = false;

			for(let i = 0; i < current.length; i++) {
				if(item.youtube_video_id === current[i].youtube_video_id) {
					found = true;
					break;
				}
			}

			if(!found){
				result.insert.push(item.youtube_video_id);
			}
		});

		return result;
	}

	static async reloadChannelDataFromYoutube (youtubeChannelId, key) {
		let result = {};

		// Get channel info
		result.channel = await this.fetchChannelInfo (youtubeChannelId, key);

		// In case of quota exceeded
		if(result.channel.error) return result.channel;

		let ids = await this.fetchChannelVideos (youtubeChannelId, key);

		// In case of quota exceeded
		if(ids.error) return ids;

		result.videos = await this.fetchVideosInfo(ids, key);

		// In case of quota exceeded
		if(result.videos.error) return result.videos;

		return result;
	}

	static async reloadChannelData (channelId, youtubeChannelId, isWorker) {
		// Choose key from DB
		let keyData = await db.chooseKey({ isWorker: isWorker });

		if(!keyData || !keyData.length) {
			return { error: 'No Youtube API keys with enough quota available right now' };
		}

		let key = { code: keyData[0].key_code, isWorker: isWorker};

		let json = await this.reloadChannelDataFromYoutube(youtubeChannelId, key);

		if(json.error) {
			return { error: 'Problem during fetching data from Youtube', details: json.error };
		}

		let item = json.channel.items[0];

		let data = { channel: {}, videos: [] };

		// Channel info
		data.channel.channel_id = channelId;
		data.channel.channel_title = item.snippet.title;
		data.channel.channel_description = item.snippet.description;
		data.channel.published = item.snippet.publishedAt;
		data.channel.thumbnails = item.snippet.thumbnails;

		data.channel.videos = parseInt(item.statistics.videoCount, 10);
		data.channel.views = parseInt(item.statistics.viewCount, 10);
		data.channel.comments = parseInt(item.statistics.commentCount, 10);
		data.channel.subscribers = parseInt(item.statistics.subscriberCount, 10);

		// Videos info
		json.videos.items.forEach((item, index) => {
			data.videos.push({
				channel_id: channelId,
				youtube_video_id: item.id,
				video_title: item.snippet.title,
				video_description: item.snippet.description,
				youtube_channel_id: item.snippet.channelId,
				duration: moment.duration(item.contentDetails.duration).asSeconds(),
				thumbnails: item.snippet.thumbnails,
				published: item.snippet.publishedAt,
				views: item.statistics.viewCount || 0,
				comments: item.statistics.commentCount || 0,
				subscribers: 0,
				likes: item.statistics.likeCount || 0,
				dislikes: item.statistics.dislikeCount || 0
			});
		});

		// Get list of existing videos
		let currentVideos = await db.getVideos({channelId: channelId, ignoreActiveFlag: true});

		// Save channel info to DB and get it's info from DB
		const channelData = await db.updateChannel(data.channel);

		const diff = this.getVideosDataDiff(currentVideos.rows, data.videos);

		await db.updateVideos(diff, data.videos);

		await this.createAutoTags(diff, data.videos);

		// Save stat for new data
		await db.statSavePrevious(channelId);

		return { videos: { new: diff.insert.length, updated: diff.update.length, deleted: diff.delete.length } };
	}

	static statWeek (lastWeekDays, lastWeekSum, currentWeekDays, currentWeekSum) {
		if(parseInt(lastWeekSum, 10) === 0 || parseInt(lastWeekDays, 10) === 0) return "No data";

		let lastWeek = 7 * lastWeekSum / lastWeekDays;
		let currentWeek = 7 * currentWeekSum / currentWeekDays;

		return ((100 * currentWeek / lastWeek) - 100).toFixed(2);
	}

	static statMonth (lastMonthDays, lastMonthSum, currentMonthDays, currentMonthSum, lastMonthTotalDays, currentMonthTotalDays) {
		if(parseInt(lastMonthSum, 10) === 0 || parseInt(lastMonthDays, 10) === 0) return "No data";

		let lastMonth = lastMonthTotalDays * lastMonthSum / lastMonthDays;
		let currentMonth = currentMonthTotalDays * currentMonthSum / currentMonthDays;

		return ((100 * currentMonth / lastMonth) - 100).toFixed(2);
	}

	static parseJSON (str) {
		let result = '';

		try {
			result = JSON.parse(str);
		}
		catch(e) {
			result = {};
		}

		return result;
	}

	static async timeout(ms) {
    	return new Promise(resolve => setTimeout(resolve, ms));
	}
}


module.exports = Youtube;