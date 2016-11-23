import express from 'express';
import xml2json from 'xml2json';
import request from 'request';
import cors from 'cors';
import _ from 'lodash';
// import throat from 'throat';
import ThrottledRequest from 'throttled-request';

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

    return Promise.all(promises)
    	.then(collections => collections.reduce((allCollectionItems, collection) => {
    			const items = collection.items.item.map(item => {
    				return Object.assign({}, item);
    			});
    			return allCollectionItems.concat(collection.items.item);
    		}, []))
    	.then(collectionsItems => _.intersectionBy(collectionsItems, 'objectid'))
    	.then(items => _.orderBy(items, 'name.$t'))
    	.then(items => _.map(items, item => {
			return Object.assign({}, item, {
				thumbnail: item.thumbnail.replace('_t.jpg', '_mt.jpg')
			});
    	}))
    	.then(items => items.reduce((prev, item) => {
			prev.push(item.objectid);
			return prev;
		}, []))
		.then(items => batchFetchThings(items))
		// .then(items => items.map(item => Object.assign({}, item.item)));  	
}

function batchFetchThings(ids) {
	return Promise.all(ids.map((id) => {
	  return fetchThing(id);
	}));
}

function fetchThing(id) {
	return fetchFromBGG(`${BGG_API_URL}thing?id=${id}`);
}

app.get('/collections/:usernames', function (req, res, next) {
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