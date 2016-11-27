import express from 'express';
import xml2json from 'xml2json';
import request from 'request';
import cors from 'cors';
import _ from 'lodash';
import ThrottledRequest from 'throttled-request';
// import mongoose from ‘mongoose’;

//DB setup
// mongoose.connect('mongodb://mongo:27017');

const BGG_API_URL = 'http://www.boardgamegeek.com/xmlapi2/';
const app = express();
const dataCache = {};

const throttledRequest = ThrottledRequest(request);
throttledRequest.configure({
  requests: 25,
  milliseconds: 10000
});

function fetchFromBGG(url) {
	if (dataCache[url]) {
		console.log(`returning from cache: ${url}`);
		return Promise.resolve(dataCache[url]);
	}

	const pending = new Promise((resolve, reject) => {
	    throttledRequest(url, function (error, response, body) {
	    	if (error || response == null) {
	    		console.log('an error occurred: ', error, body);
	    		reject(error);
	    	}

	        if (!error && response.statusCode === 200) { 
				const result = xml2json.toJson(body, {
					object: true,
					reversible: false,
					coerce: true,
					sanitize: true,
					trim: true,
					arrayNotation: false
				});

				console.log(`returning from BGG: ${url}`);
				dataCache[url] = result;
	          	resolve(result);
	        }

	        if (!error && response.statusCode === 202) {
	        	console.log(`attempting refetch: ${url}`);
	        	setTimeout(() => resolve(fetchFromBGG(url)), 1000);
	        }
	    });
	}); 

	return pending;
}

app.use(cors());

function fetchCollectionItems(usernames) {
    const promises = usernames.map(username => {
		const url = `${BGG_API_URL}collection?username=${username}&own=1&subtype=boardgame&excludesubtype=boardgameexpansion`;
		return fetchFromBGG(url);
    });

    let userCollectionsHash;

    return Promise.all(promises)
    	// first build a hash of usernames and their collections
    	.then(collections => {
    		userCollectionsHash = usernames.reduce((hash, username, index) => {
    			console.log('building collection hash for: ', username);
    			hash[username] = collections[index].items.item;
    			return hash;
    		}, {});

    		return collections;
    	})
    	// then reduce all user collections into a single collection
    	.then(collections => collections.reduce((allCollectionItems, collection) => {
    			const items = collection.items.item.map(item => {
    				return Object.assign({}, item);
    			});
    			return allCollectionItems.concat(collection.items.item);
    		}, []))
    	// then get the unique items by id
    	.then(collectionsItems => _.intersectionBy(collectionsItems, 'objectid'))
    	// then sort by name
    	.then(items => _.orderBy(items, 'name.$t'))
    	// then get a list of the ids
    	.then(items => items.reduce((prev, item) => {
			prev.push(item.objectid);
			return prev;
		}, []))
		// then get all the details for the items
		.then(items => batchFetchThings(items))
		// then turn them into our model
		.then(items => mapToModel(items, userCollectionsHash));
}

function getOwnersForGame(game, userCollectionsHash) {
	console.log('finding owners for ', game.items.item.id);
	const usernames = Object.keys(userCollectionsHash);

	return usernames.reduce((owners, username) => {
		console.log('finding if ', username, ' owns ', game.items.item.id);
		const ownsGame = userCollectionsHash[username].some(collectionItem => {
			return collectionItem.objectid === game.items.item.id;
		});

		if (ownsGame) {
			owners.push(username);
		} 

		console.log('owners for ', game.items.item.id, ' = ', owners);
		return owners;
	}, []);
}

function batchFetchThings(ids) {
	return Promise.all(ids.map((id) => {
	  return fetchThing(id);
	}));
}

function fetchThing(id) {
	return fetchFromBGG(`${BGG_API_URL}thing?id=${id}&stats=1`);
}

function mapToModel(games, userCollections) {
	return games.map(game => {
		const rank = _.find(game.items.item.statistics.ratings.ranks.rank, { name: 'boardgame'}).value;

		return {
			id: game.items.item.id,
			thumbnail: game.items.item.thumbnail.replace('_t.jpg', '_mt.jpg'),
			name: game.items.item.name instanceof Array ? game.items.item.name[0].value : game.items.item.name.value,
			yearpublished: game.items.item.yearpublished.value,
			minplayers: game.items.item.minplayers.value,
			maxplayers: game.items.item.maxplayers.value,
			owners: getOwnersForGame(game, userCollections),
			rank: rank
		};
	});
}

app.get('/collections/:usernames', function (req, res, next) {
	// res.set('Content-Type', 'application/json');
	// res.send(mapToModel(fixturesData));

	const usernames = req.params.usernames.split(';');
	const collectionItems = fetchCollectionItems(usernames);

	return collectionItems
		.then(result => {
			console.log('Success fetching /all/:usernames: ', result.length);
			res.set('Content-Type', 'application/json');
			res.send(result);
		}).catch(ex => {
			console.log('Error fetching /all/:usernames: ', ex);
			res.set('Content-Type', 'application/json');
			res.send(ex);
		});
});

app.listen(3000, function () {
  console.log('Example app listening on port 3000!')
})