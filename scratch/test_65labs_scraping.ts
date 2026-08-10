async function testScrape65labs() {
  const url = "https://www.65labs.org/jobs";
  console.log(`Fetching ${url}...`);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP Error: ${res.status}`);
    }

    const html = await res.text();
    console.log("HTML length:", html.length);

    // Let's check if __NEXT_DATA__ is present
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      console.log("Found __NEXT_DATA__ block!");
      const jsonData = JSON.parse(nextDataMatch[1]);
      console.log("Keys in __NEXT_DATA__:", Object.keys(jsonData));
      console.log("Props overview:", JSON.stringify(jsonData.props, null, 2).substring(0, 1000));
    } else {
      console.log("No __NEXT_DATA__ block found. Trying next-js data scripts...");
      // Let's search if the HTML has standard next-js chunk elements
      const hasAmi = html.includes("AMI Engineer");
      console.log("HTML contains 'AMI Engineer'?", hasAmi);
      // Let's print out a snippet of the HTML around a job entry
      const idx = html.indexOf("AMI Engineer");
      if (idx !== -1) {
        console.log("Snippet around 'AMI Engineer':\n", html.substring(idx - 200, idx + 400));
      }
    }
  } catch (err: any) {
    console.error("Scraping failed:", err.message || err);
  }
}

testScrape65labs();
