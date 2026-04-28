import {
  MarketingNav,
  MarketingFooter,
  MarketingBackdrop,
} from '@/components/marketing/marketing-shell';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <MarketingBackdrop />
      <MarketingNav />
      <div className="min-h-[calc(100vh-200px)]">{children}</div>
      <MarketingFooter />
    </div>
  );
}
