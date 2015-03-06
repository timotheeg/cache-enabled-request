var
	util    = require('util'),
	request = require('request');

module.exports = request;

// now we hijack the internal request.Request to intercept head and get requests
// this only works because we know gthe request module initializes requests as "new request.Request" (see https://github.com/timotheeg/request/blob/master/index.js#L54 )
// if Request changes its initialization protocol, this would no longer work

var originalRequest = request.Request;

var cache = {}; // for now, a single in-memory cache for the whole module

request.Request = function(options) {
	if (!options.cache_enabled || options.method !== 'GET') return new originalRequest(options); // everything works per normal, yay!

	var req_time = Date.now();

	var entry = cache[options.uri];

	if (entry) {
		if (entry.expires_at < req_time) {
			var revalidate_options = util._extend({}, options);
			revalidate_options.headers = util._extend({}, options.headers);
			delete revalidate_options.callback;

			// cache stale, must revalidate (may or may not use cache)
			// must revalidate 
		}
		else if (options.callback) {
			options.callback(null, entry.response, entry.response.body);
			// TODO: how do we enable piping here?
			return entry.response.request;
		}
	}

	return (new originalRequest(options)
		.on('response', function(res) {
			if (isCacheable(res)) {
				setCache(res, req_time, options);
			}
		})
	);
};

// TODO: setInterval to clear the cache entries

function isCacheable(options, response) {
	var req_headers = options.headers || {};
	var res_headers = response.headers || {};

	if (/no-cache/i.test(req_headers['cache-control'] || '')) return false;
	if (/no-cache/i.test(res_headers['cache-control'] || '')) return false;
	if (res_headers['etags']) return true;
	if (res_headers['expires']) return true;

	return false;
}

function setCache(response, req_time, options) {
	cache[options.uri] = {
		expires_at: getExpiryTime(response, req_time),
		response:   response
	};
}

function getExpiryTime(response, req_time) {
	var headers = response.headers || {};

	if (headers['cache-control']) {
		var m = headers['cache-control'].match(/max-age=(-?\d+)/i);
		if (m) {
			return req_time + parseInt(m[1], 10) * 1000;
		}
	}

	if (headers['expires']) {
		var origin_expiry, origin_time, origin_offset;

		try {
			origin_expiry = (new Date(headers['expires'])).getTime();
		}
		catch(e) {
			return req_time;
		}

		if (headers['date']) {
			try {
				origin_time = (new Date(headers['date'])).getTime();
			}
			catch(e) {
				return origin_expiry;
			}

			origin_offset = origin_time - req_time;

			return origin_expiry - origin_offset; // return expiry time taking offset into account
		}
	}

	return req_time; // no usable information
}
