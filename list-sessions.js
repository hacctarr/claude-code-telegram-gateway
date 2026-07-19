const fs = require('fs');
const path = require('path');
const readline = require('readline');

const projectsDir = path.join(process.env.HOME, '.claude', 'projects');

if (!fs.existsSync(projectsDir)) {
  console.log("No Claude Code project sessions found on this machine.");
  process.exit(0);
}

// Recursively find all jsonl files
function getJsonlFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getJsonlFiles(filePath));
    } else if (file.endsWith('.jsonl')) {
      results.push(filePath);
    }
  });
  return results;
}

// Parse first line of JSONL to extract title metadata
function getSessionTitle(filePath) {
  return new Promise((resolve) => {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let foundTitle = "Untitled Session";
    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        // Claude Code transcripts save titles, or prompts that can indicate title
        if (obj.title) {
          foundTitle = obj.title;
          rl.close();
        } else if (obj.message && obj.message.text && foundTitle === "Untitled Session") {
          foundTitle = obj.message.text.substring(0, 40) + "...";
        }
      } catch (e) {
        // Ignored
      }
    });

    rl.on('close', () => {
      resolve(foundTitle);
    });
  });
}

async function run() {
  console.log("Searching for local Claude sessions...");
  const files = getJsonlFiles(projectsDir);
  
  if (files.length === 0) {
    console.log("No saved session histories found.");
    return;
  }

  console.log("\n=======================================================================");
  console.log("📋 LOCAL CLAUDE SESSIONS & RESUME UUIDs");
  console.log("=======================================================================");
  
  for (const file of files) {
    const uuid = path.basename(file, '.jsonl');
    const title = await getSessionTitle(file);
    console.log(`Title: "${title}"`);
    console.log(`UUID : ${uuid}`);
    console.log("-----------------------------------------------------------------------");
  }
}

run();
