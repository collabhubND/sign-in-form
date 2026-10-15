// The kiosk's "Student consultant" list: the Fall 2026 Hub Student Consultant Schedule, plus the
// administrator, Julia Flood, and "Other". Old sign-ins keep whatever name they were saved with;
// this list only controls what a new sign-in can choose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const select = html.match(/<select id="consultantSelect"[\s\S]*?<\/select>/)[0];
const options = [...select.matchAll(/<option(?: [^>]*)?>([^<]*)<\/option>/g)].map(m => m[1].trim());

const SCHEDULE = ['Anne Scheidt', 'Annie Shedlock', 'Antonio Dominguez De Obaldia', 'Beth Martinez', 'Brody Chapman',
  'Caroline Mezzalingua', 'Charity Ihrman', 'Chloe Dsouza', 'Connor Pietsch', 'Connor Rezner', 'Darren Tanuwijaya',
  'Egan McInerney', 'Gabrielle Salles', 'Greta Prieto', 'Irene Wang', 'Isabela Egidio', 'Jack Regan', 'Karoline Klebba',
  'Lilly Vonderwell', 'Lukas Jesso', 'Maddie Evangelista', 'Mario Suarez', 'Nnanna John', 'Noah Lancz',
  'Quinn Littlefield', 'Rina Hassen', 'Rowan Miller', 'Sammy Krahl', 'Sarah Harper', 'Sofia Moreno', 'Sophie Ramos',
  'Ted Cahill', 'Vincent Mampieri'];
const ALSO = ['Josh Braganza', 'Julia Flood'];

test('the list is exactly the schedule plus the requested team members, alphabetical, then Other', () => {
  assert.equal(options[0], 'Please Select');
  assert.equal(options[options.length - 1], 'Other');
  const people = options.slice(1, -1);
  assert.deepEqual(people, [...SCHEDULE, ...ALSO].sort());
  assert.equal(new Set(people).size, people.length, 'no one is listed twice');
});

test('consultants no longer on the schedule are not offered for new sign-ins', () => {
  for (const gone of ['Akul Ghambhani', 'Alex Yu', 'Andrea Diaz Matuty', 'Carmen Castaneda', 'Connor Smith',
                      'Gabriella Simeone', 'Mariana Hernandez', 'Martha Velasco', 'Pete Kim', 'Sydney Park']) {
    assert.ok(!options.includes(gone), gone);
  }
});

test('the choice is still sent as the consultant name, so history is unaffected', () => {
  assert.match(html, /consultant_name: \$\("consultantSelect"\)\.value \|\| null,/);
});
