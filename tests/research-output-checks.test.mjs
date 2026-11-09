import test from 'node:test';
import assert from 'node:assert/strict';
import {statesUnknownMigration} from '../scripts/research-output-checks.mjs';
test('research fixture accepts explicit absence of migration information as unknown',()=>{
  for(const text of ['No source supplies migration duration. This cannot be estimated from available evidence.','No source provides a migration duration.','Migration duration is unknown.','Unknown migration duration.','Migration duration is not supplied.','The catalog does not supply migration duration information.'])assert(statesUnknownMigration(text),text);
});
test('research fixture does not infer unknown duration from a heading or a numerical estimate',()=>{
  for(const text of ['Migration duration: 3 days.','## Migration duration','No source supplies pricing. Migration duration is 4 days.','Migration duration is supplied by the vendor.','The catalog does not supply pricing. Migration duration is 4 days.'])assert.equal(statesUnknownMigration(text),false,text);
});
