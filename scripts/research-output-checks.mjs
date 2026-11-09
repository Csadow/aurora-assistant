// Presence check for the disposable research fixture only. This does not judge
// surrounding claims or prove that a recommendation follows from its sources.
export function statesUnknownMigration(text){
  return /migration[^\n]*(?:unknown|not (?:provided|specified|supplied)|unspecified)|(?:unknown|not (?:provided|specified|supplied)|unspecified)[^\n]*migration/i.test(text)
    || /\b(?:does|do) not (?:supply|provide|specify)[^.\n]*migration duration\b/i.test(text)
    || /\bno source (?:supplies|provides|specifies) (?:the |a )?migration duration\b/i.test(text);
}
