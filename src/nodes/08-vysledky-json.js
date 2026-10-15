// Výsledky (JSON) (Code, Run Once for All Items)
// Plný JSON pre každú firmu – rovnaký obsah ako stĺpec `json` v Google Sheets.
return $input.all().map(i => {
  try { return { json: JSON.parse(i.json.json) }; } catch (e) { return { json: i.json }; }
});
