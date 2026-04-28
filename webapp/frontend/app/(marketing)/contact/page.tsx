import { buildPageMetadata } from '@/lib/seo';
import ContactForm from './contact-form';

export const metadata = buildPageMetadata({
  title: 'Contact',
  description:
    'Get in touch with the team. Sales, security disclosures, support, and partnerships — all the right places to land your message.',
  path: '/contact',
});

export default function ContactPage() {
  return <ContactForm />;
}
