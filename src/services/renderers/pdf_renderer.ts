import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function generatePdf(docxPath: string, outputPath: string) {
  if (!fs.existsSync(docxPath)) {
    throw new Error(`Source DOCX file not found: ${docxPath}`);
  }

  // Use absolute paths for the COM object
  const absDocx = path.resolve(docxPath);
  const absPdf = path.resolve(outputPath);

  // Remove the destination PDF if it exists to avoid prompts
  if (fs.existsSync(absPdf)) {
    fs.unlinkSync(absPdf);
  }

  // PowerShell script to open Word, convert to PDF, and close
  const psScript = `
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = "wdAlertsNone"
    
    try {
      $doc = $word.Documents.Open('${absDocx}')
      $doc.SaveAs([ref] '${absPdf}', [ref] 17)
      $doc.Close([ref] 0)
    } catch {
      Write-Error $_.Exception.Message
      exit 1
    } finally {
      $word.Quit()
      [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
    }
  `;

  try {
    console.log("  -> Converting DOCX to PDF using MS Word COM Object...");
    await execAsync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, '; ')}"`);
    console.log("  -> PDF Conversion Complete.");
  } catch (error: any) {
    throw new Error(`Failed to convert DOCX to PDF via Word COM Object: ${error.message || error}`);
  }
}
