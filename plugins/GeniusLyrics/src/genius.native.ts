// Runs in the Electron MAIN process (Node) — exports here are auto-bridged and
// invoked from the render side. This is deliberate: genius.com does not send
// CORS headers, so fetching it from the render process is blocked. The main
// process has no CORS restrictions (this is the Luna equivalent of Spicetify's
// CosmosAsync / sendCosmosRequest that lyrics-plus relies on).

// A real browser User-Agent — Genius serves different markup / blocks some
// non-browser agents.
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const COMMON_HEADERS = {
	"User-Agent": USER_AGENT,
	Accept: "text/html,application/json,*/*",
	"Accept-Language": "en-US,en;q=0.9",
};

/** Hit Genius' public song-search endpoint. Returns the raw JSON string. */
export const geniusSearch = async (query: string): Promise<string> => {
	const params = new URLSearchParams({ per_page: "20", q: query });
	const url = `https://genius.com/api/search/song?${params.toString()}`;
	const res = await fetch(url, { headers: COMMON_HEADERS });
	if (!res.ok) throw new Error(`Genius search failed (${res.status})`);
	return await res.text();
};

/** Fetch a Genius song page. Returns the raw HTML string. */
export const geniusFetchPage = async (pageUrl: string): Promise<string> => {
	const res = await fetch(pageUrl, { headers: COMMON_HEADERS });
	if (!res.ok) throw new Error(`Genius page fetch failed (${res.status})`);
	return await res.text();
};

/** Fetch a Genius annotation by its referent ID. Returns the raw JSON string. */
export const geniusFetchAnnotation = async (id: string): Promise<string> => {
	const url = `https://genius.com/api/annotations/${id}`;
	const res = await fetch(url, { headers: COMMON_HEADERS });
	if (!res.ok) throw new Error(`Genius annotation fetch failed (${res.status})`);
	return await res.text();
};

/** Fetch a Genius referent (the "verified"/official annotation variant) by ID. Returns the raw JSON string. */
export const geniusFetchReferent = async (id: string): Promise<string> => {
	const url = `https://genius.com/api/referents/${id}`;
	const res = await fetch(url, { headers: COMMON_HEADERS });
	if (!res.ok) throw new Error(`Genius referent fetch failed (${res.status})`);
	return await res.text();
};
