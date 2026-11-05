import React from 'react';
import { translations as t } from '../lib/i18n';

interface TabsProps {
  view: 'platform' | 'company';
  activeTab: string;
  onSelectTab: (tab: string) => void;
}

export const Tabs: React.FC<TabsProps> = ({ view, activeTab, onSelectTab }) => {
  const platformTabs = [
    { id: 'overview', label: t.tabOverview },
    { id: 'offices', label: t.tabOffices },
    { id: 'users', label: t.tabUsers },
    { id: 'releases', label: t.tabReleases },
    { id: 'backup', label: t.tabBackup },
    { id: 'audit', label: t.tabAudit },
    { id: 'alerts', label: t.tabAlerts },
  ];

  const companyTabs = [
    { id: 'overview', label: t.tabOverview },
    { id: 'quarries', label: t.tabQuarries },
    { id: 'trash', label: t.tabTrash },
    { id: 'employees', label: t.tabEmployees },
    { id: 'audit', label: t.tabAudit },
  ];

  const tabs = view === 'platform' ? platformTabs : companyTabs;

  return (
    <nav className="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onSelectTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
};
