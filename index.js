var
	util    = require('util'),
	request = require('request');

module.exports = request;

// now we hijack the internal request.Request to intercept head and get requests
// this only works because we know gthe request module initializes requests as "new request.Request" (see https://github.com/timotheeg/request/blob/master/index.js#L54 )
// if Request changes its initialization protocol, this would no longer work

// req: no-cache === don't use cache for *this* request, but response *may* still be cached, based on response headers
// res: max-age=0 / expires past -> must revalidate next round, may still use cache
// res no-cache -> should not cache

// Internal cache should be a LRU cache

var OriginalRequest = request.Request;

var cache_options = {
	default_max_age:       4 * 60 * 60 * 1000, // 4 hours
	max_max_age:     30 * 24 * 60 * 60 * 1000, // 30 days
	max_size:        1 * 1024 * 1024 * 1024   // 2 GB (for response bodies only)
};

var cache_size = 0;
var cache_by_uri = {}; // for now, a single in-memory cache for the whole module
var cache_ll_first = null; // aided by a doubly-linked list for lru capability
var cache_ll_last  = null;

/* Added API */
request.getCache = function()
{
	return util._extend({}, cache_by_uri);
};

request.getCacheReport = function()
{
	// TODO: return cache report
};


/* ======================
 * Added options
 * 
 * cache_on:              if set to true, activates new cache behaviour, otherwise, leaves use request as-is
 * cache_default_max_age: max-age to compute expiry time if no expires or max-age are supplied in response (default 4h)
 * cache_forced_max_age:  Ignore response headers and use this value instead
 * cache_max_size:        maximum character the queries' responses should be alowed to consume
====================== */
request.Request = function(options)
{
	if (!options.cache_on || options.method !== 'GET') return new OriginalRequest(options); // everything works per standard request, yay!

	var req_time = Date.now(), entry;

	if (requestAllowsCache(options))
	{
		// TODO: Normalize query string?
		entry = cache_by_uri[options.uri];

		if (entry)
		{
			if (entry.expires_at > req_time)
			{
				// ============================
				// Cache is present and valid
				// ============================

				// we just return use the cache entry without making a network request

				if (options.callback)
				{
					// TODO: defer this call till next tick
					options.callback(null, entry.response, entry.response.body);
				}

				setLastUsed(entry);

				// TODO: how to return an object that looks like a request (e.g. allows piping, etc...)?
				return entry.response.request; // warning, this is a "fake" JSON request
			}
			else
			{
				// ============================
				// Cache is expired, must revalidate
				//
				// if cache contains revalidation options, we will use them
				// and handle potential "304 not modified" responses
				//
				// TODO: how to return a sensible object to the caller here?
				// TODO: handle cases where caller is not expecting response in callbacks
				// ============================

				var revalidate_headers = {}, can_revalidate = false;

				if (entry.response.headers['etag'])
				{
					revalidate_headers['If-None-match'] = entry.response.headers['etag'];
					can_revalidate = true;
				}
				if (entry.response.headers['date'])
				{
					revalidate_headers['If-Modified-Since'] = entry.response.headers['date'];
					can_revalidate = true;
				}

				if (can_revalidate)
				{
					options.headers = util._extend(revalidate_headers, options.headers);

					var original_callback = options.callback;

					options.callback = function(err, res, body)
					{
						if (err) return original_callback(err, res, body);

						if (res.statusCode === 304)
						{
							// cache is still good! Update entry fields per latest response headers
							updateCache(entry, res, req_time, options);

							// mangle response to suply cached version to caller
							original_callback(err, entry.response, entry.response.body);
						}
						else
						{
							if (responseForbidsCache(res.headers)) {
								clearCache(options.uri);
							}
							else if (res.statusCode == 200)
							{
								setCache(res, req_time, options);
							}

							original_callback(err, res, body);
						}
					};

					return new OriginalRequest(options);
				}
			}
		}
	}

	return (new OriginalRequest(options)
		.on('response', function(res)
		{
			if (responseForbidsCache(res.headers)) {
				clearCache(options.uri);
			}
			else if (res.statusCode == 200)
			{
				setCache(res, req_time, options);
			}
		})
	);
};

function requestAllowsCache(headers)
{
	if (!headers) headers = {};
	return !/no-cache/i.test(headers['cache-control']);
}

function responseForbidsCache(headers)
{
	return (headers && /no-cache/i.test(headers['cache-control']));
}

function responseAllowsCache(headers)
{
	if (!headers) headers = {};

	if (/no-cache/i.test(headers['cache-control'])) return false;

	return responseAllowsRevalidate(headers);
}

function responseAllowsRevalidate(headers)
{
	if (headers)
	{
		if (headers['etag']) return true;
		if (headers['date']) return true;
	}
	return false;
}

function setCache(response, req_time, options)
{
	clearCache(options.uri);

	var entry = cache_by_uri[options.uri] = {
		expires_at: getExpiryTime(response, req_time, options),
		response:   response.toJSON()
	};

	setLastUsed(entry);

	cache_size += (entry.response.body || {length: 0}).length;

	reclaimCache();
}

// this function is called when a response is a 304 onto an existing cache entry
var to_update = ['etag', 'expires', 'date', 'last-modified', 'cache-control'];
function updateCache(entry, response, req_time, options)
{
	entry.expires_at = getExpiryTime(response, req_time, options);

	to_update.forEach(function(header_name)
	{
		if (response.headers[header_name]) entry.response.headers[header_name] = response.headers[header_name];
	});

	setLastUsed(entry);
}

function setLastUsed(entry) {
	if (entry === cache_ll_last) return; // already last

	if (!cache_ll_first)
	{
		// first entry being added to linked list
		entry.prev = entry.next = null;
		cache_ll_first = cache_ll_last = entry;
		return;
	}

	if (entry.prev) entry.prev.next = entry.next;
	if (entry.next) entry.next.prev = entry.prev;
	if (entry === cache_ll_first) cache_ll_first = entry.next;

	entry.prev = cache_ll_last;
	cache_ll_last.next = entry;
	cache_ll_last = entry;
	cache_ll_last.next = null;
}

function clearCache(uri)
{
	var entry;

	if (typeof(uri) === 'object')
	{
		entry = uri;
		uri = entry.response.request.uri;
	}
	else {
		entry = cache_by_uri[uri];
	}

	if (!entry) return;

	cache_size -= (entry.response.body || {length: 0}).length;

	// clear cache by uri
	delete cache_by_uri[uri];

	// remove entry from linked list
	if (cache_ll_first === entry) cache_ll_first = entry.next;
	if (cache_ll_last  === entry) cache_ll_last  = entry.prev;
	if (entry.prev) entry.prev.next = entry.next;
	if (entry.next) entry.next.prev = entry.prev;
}

function reclaimCache()
{
	while (cache_size >= cache_options.max_size)
	{
		clearCache(cache_ll_first);
	}
}

function getExpiryTime(response, req_time, options)
{
	// if forced_max_age is supplied, we use that
	if (typeof(options.cache_forced_max_age) === 'number')
	{
		return req_time + options.cache_forced_max_age;
	}

	var headers = response.headers || {};

	if (headers['cache-control'])
	{
		var m = headers['cache-control'].match(/max-age=(-?\d+)/i);
		if (m)
		{
			return req_time + parseInt(m[1], 10) * 1000;
		}
	}

	if (headers['expires'])
	{
		var origin_expiry, origin_time, origin_offset;

		try
		{
			origin_expiry = (new Date(headers['expires'])).getTime();
		}
		catch(e)
		{
			return req_time;
		}

		if (headers['date'])
		{
			try
			{
				origin_time = (new Date(headers['date'])).getTime();
			}
			catch(e)
			{
				return origin_expiry;
			}

			origin_offset = origin_time - req_time;

			return origin_expiry - origin_offset; // return expiry time taking offset into account
		}

		return origin_expiry;
	}

	// allows caller to set whatever default expiry they wish
	if (typeof(options.cache_default_max_age) === 'number')
	{
		return req_time + options.cache_default_max_age;
	}

	return req_time + cache_options.default_max_age;
}
