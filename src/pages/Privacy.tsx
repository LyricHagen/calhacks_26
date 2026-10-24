import { QLink } from '../util';
import { DocPage, type Sec } from './Doc';

const SECS: Sec[] = [
  {
    id: 'measured', title: 'What is measured',
    body: <p>Force on the glove and the five torso pads, wrist movement and angle, and the time of each reading. Nothing about you or your computer.</p>,
  },
  {
    id: 'where', title: 'Where the data goes',
    body: <p>Nowhere beyond this computer. The trainer sends its readings over a USB cable to this page, and the page sends nothing on.</p>,
  },
  {
    id: 'uploads', title: 'Nothing is uploaded',
    body: <p>No accounts, no analytics, no tracking, no cookies. Fonts ship inside the page, so opening it contacts no outside server.</p>,
  },
  {
    id: 'kept', title: 'How long it is kept',
    body: <p>A session lives in this page&rsquo;s memory while it is open. The last finished session is also kept in this tab&rsquo;s session storage, so a reload does not lose it. Closing the tab clears both.</p>,
  },
  {
    id: 'sharing', title: 'Keeping a result',
    body: <p>Press <strong>Save session</strong> on the <QLink to="/session/summary">summary</QLink> to download it as one file, or take a screenshot. That copy is yours, on your computer, and goes nowhere unless you send it.</p>,
  },
];

export function PrivacyPage() {
  return (
    <DocPage
      title="Privacy"
      lede={<p>Data stays on this computer, nothing is uploaded, and nothing is kept after you close the tab.</p>}
      secs={SECS}
    />
  );
}
