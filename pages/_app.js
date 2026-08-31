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
      </Head>
      <Component {...pageProps} />
    </>
  );
}
