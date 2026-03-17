'use strict';

// RFC 4180 CSV line parser — shared by stops.js and vehicles.js
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) { fields.push(field); field = ''; }
    else { field += ch; }
  }
  fields.push(field);
  return fields;
}

module.exports = { parseCsvLine };
