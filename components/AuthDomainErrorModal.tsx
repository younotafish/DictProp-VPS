import React from 'react';
import { X, ShieldAlert, Copy, ExternalLink, Check, AlertTriangle } from 'lucide-react';
import { Button } from './Button';

interface Props {
  domain: string;
  onClose: () => void;
}

export const AuthDomainErrorModal: React.FC<Props> = ({ domain, onClose }) => {
  const [copied, setCopied] = React.useState(false);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  // Fallback logic: prioritize host (includes port) over hostname, as preview environments often need port.
  // Including origin as a fallback for context as requested.
  const displayDomain = domain || window.location.host || window.location.origin || "Unable to detect URL";

  const handleCopy = () => {
    navigator.clipboard.writeText(displayDomain);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-4 bg-red-50 border-b border-red-100 flex justify-between items-center shrink-0">
          <h3 className="font-bold text-red-700 flex items-center gap-2">
            <ShieldAlert className="text-red-600" size={20} />
            Domain Unauthorized
          </h3>
          <button onClick={onClose} className="text-red-400 hover:text-red-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
           <p className="text-sm text-slate-600 mb-4 leading-relaxed">
             Google Sign-In is blocked because the current domain hasn't been added to your Firebase allowlist.
           </p>

           <div className="bg-slate-100 p-3 rounded-xl border border-slate-200 mb-6 flex items-center justify-between gap-2">
               <code className="text-xs font-mono text-slate-700 font-bold break-all">{displayDomain}</code>
               <button 
                 onClick={handleCopy} 
                 className="p-2 bg-white rounded-lg shadow-sm hover:bg-indigo-50 text-slate-500 hover:text-indigo-600 transition-colors shrink-0"
                 title="Copy Domain"
               >
                   {copied ? <Check size={16} className="text-green-500"/> : <Copy size={16} />}
               </button>
           </div>

           <h4 className="text-xs font-bold text-slate-400 uppercase mb-3">How to fix it:</h4>
           <ol className="text-sm text-slate-600 space-y-3 mb-6 list-decimal pl-4">
               <li>Go to <a href="https://console.firebase.google.com" target="_blank" className="text-indigo-600 font-semibold hover:underline">Firebase Console</a> &rarr; Authentication.</li>
               <li>Click the <strong>Settings</strong> tab.</li>
               <li>Scroll to <strong>Authorized Domains</strong>.</li>
               <li>Click <strong>Add domain</strong> and paste the domain above.</li>
           </ol>

            <div className="bg-amber-50 p-3 rounded-lg border border-amber-100 mb-6">
                <button 
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center gap-2 text-xs font-bold text-amber-700 w-full text-left"
                >
                    <AlertTriangle size={14} />
                    Still not working?
                </button>
                {showAdvanced && (
                    <div className="mt-2 text-xs text-amber-800 space-y-2">
                        <p>1. <strong>Wait 5-10 mins:</strong> Changes take time to propagate.</p>
                        <p>2. <strong>Enable Google:</strong> Ensure "Google" is enabled in the <em>Sign-in method</em> tab.</p>
                        <p>3. <strong>API Key Restrictions:</strong> If you restricted your API Key in Google Cloud Console to specific websites, you must add this domain there too (not just Firebase).</p>
                    </div>
                )}
            </div>

           <div className="flex gap-3">
               <Button variant="secondary" onClick={onClose} className="flex-1">Close</Button>
               <a 
                 href="https://console.firebase.google.com/project/_/authentication/settings" 
                 target="_blank" 
                 rel="noreferrer"
                 className="flex-1"
               >
                   <Button className="w-full flex items-center justify-center gap-2">
                       Open Console <ExternalLink size={16} />
                   </Button>
               </a>
           </div>
        </div>
      </div>
    </div>
  );
};
