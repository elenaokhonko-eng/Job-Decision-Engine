async function testParsing() {
  const url = "https://www.65labs.org/jobs";
  console.log(`Fetching and parsing ${url}...`);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const html = await res.text();

    // Split HTML by company sections
    // The sections are separated by `<section class="border-b border-brand-line`
    const sections = html.split(/<section class="border-b border-brand-line/);
    // The first segment is page header, skip it
    sections.shift();

    const jobsList: any[] = [];
    console.log(`Found ${sections.length} company sections.`);

    for (const section of sections) {
      // 1. Extract Company Name
      const companyMatch = section.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      if (!companyMatch) continue;
      const company = companyMatch[1].trim();

      // 2. Extract Company Desc (optional)
      const descMatch = section.match(/<p class="text-base text-brand-muted">([\s\S]*?)<\/p>/);
      const companyDesc = descMatch ? descMatch[1].trim() : "";

      // 3. Extract Job items inside this section
      // Job segments are divided by the `<div class="grid gap-3 border-t border-brand-line`
      const jobSegments = section.split(/<div class="grid gap-3 border-t border-brand-line|md:grid-cols-\[minmax\(0,1fr\)_auto\] md:items-center/);
      // Skip the first segment because it contains h2 and description, not job item
      jobSegments.shift();

      for (const segment of jobSegments) {
        const titleMatch = segment.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
        const linkMatch = segment.match(/href="([^"]+)"/);
        const locMatch = segment.match(/<p class="mt-1 text-sm text-brand-muted">([\s\S]*?)<\/p>/);

        if (titleMatch && linkMatch) {
          const title = titleMatch[1].trim();
          const applyUrl = linkMatch[1].trim();
          const location = locMatch ? locMatch[1].trim() : "Singapore";

          jobsList.push({
            company,
            companyDesc,
            title,
            location,
            applyUrl
          });
        }
      }
    }

    console.log(`Successfully parsed ${jobsList.length} jobs!`);
    console.log("\nSample Jobs parsed:");
    jobsList.slice(0, 10).forEach((j, i) => {
      console.log(`[#${i+1}] ${j.title} at ${j.company} (Location: ${j.location})`);
      console.log(`     Link: ${j.applyUrl}`);
    });
  } catch (err: any) {
    console.error("Parsing failed:", err.message || err);
  }
}

testParsing();
