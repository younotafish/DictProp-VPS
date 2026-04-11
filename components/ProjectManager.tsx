import React, { useState, useRef, useEffect } from 'react';
import { ProjectInfo, StoredItem } from '../types';
import { X, Plus, Pencil, Trash2, FolderOpen, Check, Loader2 } from 'lucide-react';

interface ProjectManagerProps {
  isOpen: boolean;
  onClose: () => void;
  projects: ProjectInfo[];
  onRefreshProjects?: () => Promise<void>;
  onCreateProject: (name: string) => Promise<ProjectInfo>;
  onRenameProject: (id: string, name: string) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  allItems: StoredItem[];
}

export const ProjectManager: React.FC<ProjectManagerProps> = ({
  isOpen,
  onClose,
  projects,
  onRefreshProjects,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  allItems,
}) => {
  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Refresh projects from server when modal opens
  useEffect(() => {
    if (isOpen && onRefreshProjects) {
      onRefreshProjects();
    }
  }, [isOpen]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const getItemCount = (projectId: string) =>
    allItems.filter(i => !i.isDeleted && i.project === projectId).length;

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setIsCreating(true);
    setError(null);
    try {
      await onCreateProject(newName.trim());
      setNewName('');
    } catch (e: any) {
      setError(e.message || 'Failed to create project');
    } finally {
      setIsCreating(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) { setEditingId(null); return; }
    setError(null);
    try {
      await onRenameProject(id, editName.trim());
      setEditingId(null);
    } catch (e: any) {
      setError(e.message || 'Failed to rename project');
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    setDeletingId(id);
    try {
      await onDeleteProject(id);
    } catch (e: any) {
      setError(e.message || 'Failed to delete project');
    } finally {
      setDeletingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col animate-in slide-in-from-bottom duration-300">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-200 bg-white/90 backdrop-blur-md flex items-center gap-3">
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors"
        >
          <X size={20} />
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <FolderOpen size={20} className="text-indigo-600" />
            Manage Projects
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">{projects.length} project{projects.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8">
        {error && (
          <div className="mb-4 px-4 py-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm">
            {error}
          </div>
        )}

        {/* Create new project */}
        <div className="flex gap-2 mb-6">
          <input
            ref={newInputRef}
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
            placeholder="New project name..."
            className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
            disabled={isCreating}
          />
          <button
            onClick={handleCreate}
            disabled={!newName.trim() || isCreating}
            className={`px-4 py-2.5 rounded-xl font-semibold text-sm transition-all flex items-center gap-1.5 ${
              !newName.trim() || isCreating
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white active:scale-[0.98]'
            }`}
          >
            {isCreating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create
          </button>
        </div>

        {/* Project list */}
        {projects.length === 0 ? (
          <div className="flex flex-col items-center py-12 px-6 text-center">
            <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-5">
              <FolderOpen size={32} className="text-indigo-300" />
            </div>
            <h3 className="text-lg font-bold text-slate-700 mb-2">No Projects Yet</h3>
            <p className="text-sm text-slate-400 max-w-xs leading-relaxed">
              Create a project to organize your vocabulary into collections.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map(project => {
              const count = getItemCount(project.id);
              const isEditing = editingId === project.id;
              const isDeleting = deletingId === project.id;

              return (
                <div
                  key={project.id}
                  className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 bg-white hover:border-slate-200 transition-colors"
                >
                  <FolderOpen size={18} className="text-indigo-400 shrink-0" />

                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRename(project.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => handleRename(project.id)}
                      className="flex-1 px-2 py-1 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  ) : (
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold text-slate-700 text-sm">{project.name}</span>
                      <span className="text-xs text-slate-400 ml-2">{count} item{count !== 1 ? 's' : ''}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-1 shrink-0">
                    {isEditing ? (
                      <button
                        onClick={() => handleRename(project.id)}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-emerald-600 hover:bg-emerald-50 transition-colors"
                      >
                        <Check size={14} strokeWidth={3} />
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => { setEditingId(project.id); setEditName(project.name); }}
                          className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                          title="Rename"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(project.id)}
                          disabled={isDeleting}
                          className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors"
                          title="Delete project (items become uncategorized)"
                        >
                          {isDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-slate-400 mt-6 text-center">
          Deleting a project keeps all its items — they become uncategorized.
        </p>
      </div>
    </div>
  );
};
