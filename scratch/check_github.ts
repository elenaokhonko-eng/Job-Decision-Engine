import https from 'https';

function getJobs() {
  const options = {
    hostname: 'api.github.com',
    path: '/repos/elenaokhonko-eng/Job-Decision-Engine/actions/runs/30734296710/jobs',
    method: 'GET',
    headers: {
      'User-Agent': 'NodeJS-Agent'
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.jobs) {
          json.jobs.forEach((job: any) => {
            console.log(`- Job Name: ${job.name}`);
            console.log(`  Status: ${job.status}`);
            console.log(`  Conclusion: ${job.conclusion}`);
            console.log(`  Started At: ${job.started_at}`);
            console.log(`  Steps:`);
            job.steps.forEach((step: any) => {
              console.log(`    * [${step.status}] ${step.name} (Conclusion: ${step.conclusion})`);
            });
          });
        } else {
          console.log(data);
        }
      } catch (err: any) {
        console.error("Parse error:", err.message);
      }
    });
  });

  req.on('error', (e) => {
    console.error(`Request error: ${e.message}`);
  });
  req.end();
}

getJobs();
