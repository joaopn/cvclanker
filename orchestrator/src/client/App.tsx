/**
 * Main App component.
 */

import React, { useEffect, useRef } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { CSSTransition, SwitchTransition } from "react-transition-group";

import { Toaster } from "@/components/ui/sonner";
import { OnboardingGate } from "./components/OnboardingGate";
import { setAuthNavigator } from "./lib/auth-navigation";
import { CoverLetterPage } from "./pages/CoverLetterPage";
import { CvPage } from "./pages/CvPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { OrchestratorPage } from "./pages/OrchestratorPage";
import { ProfileEditorPage } from "./pages/ProfileEditorPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SchedulingPausedBanner } from "./components/SchedulingPausedBanner";
import { SchedulePage } from "./pages/SchedulePage";
import { SettingsPage } from "./pages/SettingsPage";
import { SignInPage } from "./pages/SignInPage";
import { SourcesPage } from "./pages/SourcesPage";
import { SwipePage } from "./pages/SwipePage";

/** Backwards-compatibility redirects: old URL paths -> new URL paths */
const REDIRECTS: Array<{ from: string; to: string }> = [
  { from: "/", to: "/jobs/ready" },
  { from: "/ready", to: "/jobs/ready" },
  { from: "/ready/:jobId", to: "/jobs/ready/:jobId" },
  { from: "/discovered", to: "/jobs/discovered" },
  { from: "/discovered/:jobId", to: "/jobs/discovered/:jobId" },
  { from: "/applied", to: "/jobs/applied" },
  { from: "/applied/:jobId", to: "/jobs/applied/:jobId" },
  { from: "/all", to: "/jobs/all" },
  { from: "/all/:jobId", to: "/jobs/all/:jobId" },
];

export const App: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const nodeRef = useRef<HTMLDivElement>(null);

  // Determine a stable key for transitions to avoid unnecessary unmounts when switching sub-tabs
  const pageKey = React.useMemo(() => {
    const firstSegment = location.pathname.split("/")[1] || "jobs";
    if (firstSegment === "jobs") {
      return "orchestrator";
    }
    return firstSegment;
  }, [location.pathname]);

  useEffect(() => {
    setAuthNavigator((nextPath) => {
      const search = new URLSearchParams();
      if (
        nextPath &&
        nextPath !== "/sign-in" &&
        !nextPath.startsWith("/sign-in?")
      ) {
        search.set("next", nextPath);
      }
      navigate(`/sign-in${search.toString() ? `?${search.toString()}` : ""}`, {
        replace: true,
      });
    });

    return () => {
      setAuthNavigator(null);
    };
  }, [navigate]);

  return (
    <>
      <OnboardingGate />
      {/* Above the routed page, so a paused scheduler is visible from
          everywhere rather than only from the tab nobody opens. */}
      <SchedulingPausedBanner />
      <div>
        <SwitchTransition mode="out-in">
          <CSSTransition
            key={pageKey}
            nodeRef={nodeRef}
            timeout={100}
            classNames="page"
            unmountOnExit
          >
            <div ref={nodeRef}>
              <Routes location={location}>
                {/* Backwards-compatibility redirects */}
                {REDIRECTS.map(({ from, to }) => (
                  <Route
                    key={from}
                    path={from}
                    element={<Navigate to={to} replace />}
                  />
                ))}

                {/* Application routes */}
                <Route path="/onboarding" element={<OnboardingPage />} />
                <Route path="/sign-in" element={<SignInPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/cv" element={<CvPage />} />
                <Route path="/cover-letter" element={<CoverLetterPage />} />
                <Route path="/sources" element={<SourcesPage />} />
                <Route path="/profiles" element={<ProfilesPage />} />
                <Route path="/profiles/new" element={<ProfileEditorPage />} />
                <Route path="/profiles/:id" element={<ProfileEditorPage />} />
                <Route path="/swipe" element={<SwipePage />} />
                <Route path="/schedule" element={<SchedulePage />} />
                <Route path="/jobs/:tab" element={<OrchestratorPage />} />
                <Route
                  path="/jobs/:tab/:jobId"
                  element={<OrchestratorPage />}
                />
              </Routes>
            </div>
          </CSSTransition>
        </SwitchTransition>
      </div>

      <Toaster position="bottom-right" richColors closeButton />
    </>
  );
};
