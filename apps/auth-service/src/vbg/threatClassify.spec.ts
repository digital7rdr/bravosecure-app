import {classifyThreat} from './threatClassify';

describe('classifyThreat', () => {
  it('catches REAL local incidents across types', () => {
    const cases: Array<[string, 'critical' | 'caution']> = [
      ["Fire erupts in Islamabad's Jinnah Super Market", 'caution'],
      ['Kashmir faces shutdown as protests leave more than 20 dead', 'critical'],
      ['Three suspected militants killed in raid', 'critical'],
      ['Two Black Axe cultists remanded over attempted murder', 'critical'],
      ['Acid attack victim shifted to hospital', 'critical'],
      ['Mob attacks police following child murder', 'critical'],
      ['Armed robbery at jewellery shop', 'critical'],
      ['Road accident on motorway leaves several injured', 'caution'],
      ['Police raid drug den, several detained', 'caution'],
      ['Protesters block highway over power cuts', 'caution'],
    ];
    for (const [title, sev] of cases) {
      expect(classifyThreat(title).severity).toBe(sev);
    }
  });

  it('rejects non-incident NOISE as information', () => {
    const noise = [
      'Lebanon ceasefire agreed after US-Iran talks in Switzerland',
      'Benazir Bhutto And The Politics Of Hope',
      'The leopard princess of Islamabad',
      'In call with MBS, PM Shehbaz discusses trade',
      'Hoshiarpur women cricket team enter final with 95-run victory',
      'Pakistan stock market rally continues amid economic optimism',
      'New film breaks box office records this weekend',
    ];
    for (const title of noise) {
      expect(classifyThreat(title).severity).toBe('information');
    }
  });
});
