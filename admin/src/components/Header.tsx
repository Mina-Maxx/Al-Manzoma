import React from 'react';
import { translations as t } from '../lib/i18n';
import { UserSession } from '../lib/types';

interface HeaderProps {
  session: UserSession | null;
  currentView: 'platform' | 'company';
  activeCompanyName?: string | null;
  onSwitchView: (view: 'platform' | 'company') => void;
  onSignOut: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  session,
  currentView,
  activeCompanyName,
  onSwitchView,
  onSignOut,
}) => {
  return (
    <header className="header-bar">
      <div className="spread">
        <div>
          <h1>{currentView === 'platform' ? t.platformTitle : t.companyTitle}</h1>
          <p className="muted">
            {currentView === 'platform'
              ? t.platformSubtitle
              : activeCompanyName
              ? t.viewingAsSuperAdmin.replace('{name}', activeCompanyName)
              : ''}
          </p>
        </div>
        <div className="row">
          {session?.user.isSuperAdmin && currentView === 'company' && (
            <button
              className="button secondary"
              onClick={() => onSwitchView('platform')}
            >
              {t.returnToPlatform}
            </button>
          )}

          {session && (
            <div className="row" style={{ alignItems: 'center' }}>
              <span className="muted">
                {t.signedInAs} <strong>{session.user.username}</strong>
              </span>
              <button className="button danger" onClick={onSignOut}>
                {t.signOut}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
