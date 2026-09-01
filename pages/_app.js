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

        {/* Share cards. A link posted to X or sent in a DM renders as a
            bare URL without these, which wastes the impression. og:image
            must be an ABSOLUTE url — crawlers do not resolve relative
            paths against the page. */}
        <meta property="og:title" content="MarketSlap — compare prediction markets across Kalshi and Polymarket" />
        <meta
          property="og:description"
          content="The same claim, priced side by side on Kalshi, Polymarket and Polymarket US — with each venue's fees in the number."
        />
        <meta property="og:image" content="https://marketslap.com/og.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:url" content="https://marketslap.com/" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="MarketSlap" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@MarketSlap" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
