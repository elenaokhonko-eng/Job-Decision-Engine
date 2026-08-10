import https from 'https';

function getLogs() {
  const options = {
    hostname: 'api.github.com',
    path: '/repos/elenaokhonko-eng/Job-Decision-Engine/actions/jobs/91460070501/logs',
    method: 'GET',
    headers: {
      'User-Agent': 'NodeJS-Agent',
      'Accept': 'application/vnd.github.v3.raw'
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      const lines = data.split('\n');
      console.log(`Total log lines: ${lines.length}`);
      console.log("Last 40 lines of log:");
      console.log(lines.slice(-40).join('\n'));
    });
  });

  req.on('error', (e) => {
    console.error(`Request error: ${e.message}`);
  });
  req.end();
}

getLogs();
