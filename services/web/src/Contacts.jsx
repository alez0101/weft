// An address book: people and organisations a space keeps in touch with (name, organisation, phone,
// email and notes), sorted by name, with a filter that matches any field. Editors add, change and delete;
// viewers read. Row-level security decides; when it says no, the reason is shown and the book is reloaded.
// Live: any change to this book's contacts refetches it.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const EMPTY = { name: '', organisation: '', phone: '', email: '', notes: '' };
// The database keeps only these characters in a phone number and a plain address in email, so both are
// safe in tel: and mailto: links; the checks here only decide whether to make the link.
const telOf = (p) => p.replace(/[^0-9+]/g, '');
const okEmail = (e) => /^[^\s@<>"(),;:?&/\\[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(e);
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function ContactForm({ initial, onSave, onCancel, label, idp, submit: submitLabel }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    onSave({ name: f.name.trim(), organisation: f.organisation.trim(), phone: f.phone.trim(), email: f.email.trim(), notes: f.notes.trim() }, () => setF(EMPTY));
  };
  return (
    <form className="link-form" onSubmit={submit} aria-label={label} noValidate>
      <label htmlFor={`${idp}-name`}>Name</label>
      <input id={`${idp}-name`} value={f.name} onChange={set('name')} maxLength={120} autoComplete="off" required />
      <label htmlFor={`${idp}-org`}>Organisation</label>
      <input id={`${idp}-org`} value={f.organisation} onChange={set('organisation')} maxLength={120} autoComplete="off" />
      <label htmlFor={`${idp}-phone`}>Phone</label>
      <input id={`${idp}-phone`} value={f.phone} onChange={set('phone')} maxLength={40} inputMode="tel" autoComplete="off" placeholder="+44 20 7946 0000" />
      <label htmlFor={`${idp}-email`}>Email</label>
      <input id={`${idp}-email`} type="email" value={f.email} onChange={set('email')} maxLength={200} autoComplete="off" />
      <label htmlFor={`${idp}-notes`}>Notes</label>
      <textarea id={`${idp}-notes`} value={f.notes} onChange={set('notes')} placeholder="What they help with, when to call" maxLength={2000} rows={2} />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!f.name.trim()}>{submitLabel}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function ContactList({ item, editable, notice }) {
  const [contacts, setContacts] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api(`/contacts?book_id=eq.${item.id}&select=id,name,organisation,phone,email,notes,created_at,author:users!contacts_created_by_fkey(display_name)&order=name,created_at`)
    .then((r) => { setContacts(r); }), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The address book could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'contacts' && notice.book === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const add = async (body, reset) => {
    if (await change('Could not add the contact', () => api('/contacts', { method: 'POST', body: { ...body, book_id: item.id }, prefer: 'return=minimal' }))) { reset(); setAdding(false); }
  };
  const save = async (c, body) => {
    if (await change('That change was not saved', () => api(`/contacts?id=eq.${c.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null);
  };
  const remove = (c) => {
    if (!window.confirm(`Delete ${c.name}? Everyone who can see this address book loses the contact.`)) return;
    change('Could not delete', () => api(`/contacts?id=eq.${c.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!contacts) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the address book"><span /><span /><span /></div>;
  const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = sorted.filter((c) => words.every((w) => `${c.name} ${c.organisation} ${c.phone} ${c.email} ${c.notes}`.toLowerCase().includes(w)
    || (w.replace(/[^0-9]/g, '').length >= 3 && c.phone.replace(/[^0-9]/g, '').includes(w.replace(/[^0-9]/g, '')))));

  return (
    <div className="links contacts">
      {editable ? (adding
        ? <ContactForm initial={EMPTY} onSave={add} onCancel={() => setAdding(false)} label="Add a contact" idp="contact-new" submit="Add contact" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Add a contact</button>
            <p className="docs-hint">Only members of this space can see these contacts.</p></div>)
        : <p className="docs-hint">You can read these contacts. Ask an owner of the space to make you an editor to add or change them.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {contacts.length > 0 && (
        <div className="links-filters">
          <label className="visually-hidden" htmlFor="contacts-find">Find a contact</label>
          <input id="contacts-find" type="search" placeholder="Find by name, phone, email…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="task-count" role="status">{shown.length === contacts.length ? `${contacts.length} contact${contacts.length === 1 ? '' : 's'}` : `${shown.length} of ${contacts.length}`}</span>
        </div>
      )}
      {!contacts.length ? <p className="convo-empty">{editable ? 'No contacts yet. Add the first one above.' : 'No contacts yet.'}</p>
        : !shown.length ? <p className="convo-empty">No contacts match.</p> : (
        <ul className="link-list" aria-label="Contacts">
          {shown.map((c) => (
            <li key={c.id} className="link contact">
              {editing === c.id ? (
                <ContactForm initial={{ name: c.name, organisation: c.organisation, phone: c.phone, email: c.email, notes: c.notes }} onSave={(b) => save(c, b)} onCancel={() => setEditing(null)} label={`Edit ${c.name}`} idp={`contact-${c.id}`} submit="Save" />
              ) : (<>
                <div className="contact-head">
                  <span className="contact-badge" aria-hidden="true">{initials(c.name)}</span>
                  <div className="contact-who">
                    <span className="contact-name">{c.name}</span>
                    {c.organisation && <span className="link-host">{c.organisation}</span>}
                  </div>
                </div>
                {(c.phone || c.email) && (
                  <p className="contact-ways">
                    {c.phone && (telOf(c.phone) ? <a className="contact-way" href={`tel:${telOf(c.phone)}`}><span className="visually-hidden">Phone </span>{c.phone}</a> : <span className="contact-way">{c.phone}</span>)}
                    {c.email && (okEmail(c.email) ? <a className="contact-way" href={`mailto:${c.email}`}><span className="visually-hidden">Email </span>{c.email}</a> : <span className="contact-way">{c.email}</span>)}
                  </p>
                )}
                {c.notes && <p className="link-note">{c.notes}</p>}
                <div className="link-foot">
                  <span className="link-by">{c.author?.display_name ? `Added by ${c.author.display_name}` : ''}</span>
                  {editable && <>
                    <button className="btn btn--sm" type="button" onClick={() => setEditing(c.id)}>Edit<span className="visually-hidden"> {c.name}</span></button>
                    <button className="btn btn--sm" type="button" onClick={() => remove(c)}>Delete<span className="visually-hidden"> {c.name}</span></button>
                  </>}
                </div>
              </>)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
