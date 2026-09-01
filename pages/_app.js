import Head from "next/head";

import "@/styles/globals.css";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        {/* Without this a phone lays the page out at ~980px and scales
            the result down: every card fits, and every word is too small
            to read. It is the whole reason the site was unusable on the
            device most people will open it on.

            It lives here rather than in _document, which Next rejects —
            a viewport tag there is not merged per-page and it warns. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />

        {/* There was no <title> in the app at all, so the browser tab
            rendered the bare URL and a bookmark saved as the hostname. */}
        <title>MarketSlap — compare prediction markets across Kalshi and Polymarket</title>
        <meta
          name="description"
          content="Side-by-side prices for the same claim on Kalshi, Polymarket and Polymarket US, with executable costs that include each venue's fees."
        />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta name="theme-color" content="#040F29" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
