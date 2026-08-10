import fs from 'fs';

function run() {
  const filepath = 'C:/Users/dance/.gemini/antigravity-ide/brain/4722e114-7c4d-4fe4-b811-5c450400c16d/.system_generated/tasks/task-2471.log';
  if (!fs.existsSync(filepath)) {
    console.log("Log file does not exist.");
    return;
  }
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split('\n');
  console.log(`Searching ${lines.length} lines in log file...`);
  
  lines.forEach((line, i) => {
    if (line.toLowerCase().includes('bjak')) {
      console.log(`[Line ${i+1}] ${line}`);
    }
  });
}

run();
