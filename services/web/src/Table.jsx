// A table: typed columns and rows in an AG Grid (Community). Cells are saved one at a time through
// weft.set_cell, so two people editing different cells never overwrite each other; row-level security
// decides who can read and who can change. Live notices update only the row that changed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import { api } from './api.js';

ModuleRegistry.registerModules([AllCommunityModule]);

// The grid takes Weft's tokens, so it follows light and dark mode.
const theme = themeQuartz.withParams({
  backgroundColor: 'var(--color-paper)', foregroundColor: 'var(--color-ink)', textColor: 'var(--color-ink)',
  accentColor: 'var(--color-accent-deep)', borderColor: 'var(--color-rule)',
  headerBackgroundColor: 'var(--color-paper-2)', headerTextColor: 'var(--color-ink-2)', chromeBackgroundColor: 'var(--color-paper-2)',
  oddRowBackgroundColor: 'var(--color-paper)', rowHoverColor: 'var(--color-paper-2)', selectedRowBackgroundColor: 'var(--color-accent-soft)',
  fontFamily: 'var(--font-body)', fontSize: 14, wrapperBorderRadius: 14, browserColorScheme: 'inherit',
});

const TYPES = { text: 'Text', number: 'Number', date: 'Date', checkbox: 'Checkbox', select: 'Choice' };
const toRow = (r) => ({ __id: r.id, __pos: r.position, ...r.cells });

export default function Table({ item, editable, notice }) {
  const grid = useRef(null);
  const [cols, setCols] = useState(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  const [newCol, setNewCol] = useState({ name: '', type: 'text', options: '' });
  const [manage, setManage] = useState(false);

  const loadCols = useCallback(() => api(`/table_columns?table_id=eq.${item.id}&select=id,name,type,options,position&order=position`).then(setCols), [item.id]);
  const loadRows = useCallback(() => api(`/table_rows?table_id=eq.${item.id}&select=id,cells,position&order=position`).then((r) => setRows(r.map(toRow))), [item.id]);
  useEffect(() => { Promise.all([loadCols(), loadRows()]).catch((e) => setError(`The table could not load: ${e.message}`)); }, [loadCols, loadRows]);

  // Live: a changed row is patched in place (so an edit in progress elsewhere is not disturbed).
  useEffect(() => {
    if (!notice || notice.table !== item.id) return;
    if (notice.t === 'table_columns') { loadCols().catch(() => {}); return; }
    if (notice.t !== 'table_rows') return;
    const g = grid.current?.api;
    if (notice.op === 'DELETE') { g?.applyTransaction({ remove: [{ __id: notice.id }] }); return; }
    api(`/table_rows?id=eq.${notice.id}&select=id,cells,position`).then(([r]) => {
      if (!r || !g) return;
      const exists = g.getRowNode(r.id);
      g.applyTransaction(exists ? { update: [toRow(r)] } : { add: [toRow(r)] });
    }).catch(() => {});
  }, [notice, item.id, loadCols]);

  const columnDefs = useMemo(() => (cols || []).map((c) => ({
    field: c.id, headerName: c.name, editable, minWidth: 110, flex: c.type === 'text' ? 2 : 1,
    ...(c.type === 'number' ? { cellDataType: 'number' } : {}),
    ...(c.type === 'checkbox' ? { cellDataType: 'boolean' } : {}),
    ...(c.type === 'date' ? { cellDataType: 'dateString' } : {}),
    ...(c.type === 'select' ? { cellDataType: 'text', cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['', ...(c.options || [])] } } : {}),
  })), [cols, editable]);

  const onCellValueChanged = async (e) => {
    const value = e.newValue === '' || e.newValue === undefined ? null : e.newValue;
    try {
      const n = await api('/rpc/set_cell', { method: 'POST', body: { p_row: e.data.__id, p_column: e.colDef.field, p_value: value } });
      if (n !== 1) throw new Error('not allowed');
      setError('');
    } catch (err) {
      e.node.setDataValue(e.colDef.field, e.oldValue); // put it back
      setError(`That change was not saved: ${err.message}`);
    }
  };

  async function addRow() {
    const pos = Math.max(-1, ...(rows || []).map((r) => r.__pos)) + 1;
    try {
      const [r] = await api('/table_rows', { method: 'POST', body: { table_id: item.id, cells: {}, position: pos }, prefer: 'return=representation' });
      grid.current?.api.applyTransaction({ add: [toRow(r)] }); setRows((x) => [...(x || []), toRow(r)]);
    } catch (err) { setError(`Could not add a row: ${err.message}`); }
  }
  async function deleteSelected() {
    const ids = grid.current?.api.getSelectedRows().map((r) => r.__id) || [];
    if (!ids.length || !window.confirm(`Delete ${ids.length} row${ids.length > 1 ? 's' : ''}? Everyone who can see this table loses ${ids.length > 1 ? 'them' : 'it'}.`)) return;
    try { await api(`/table_rows?id=in.(${ids.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' }); grid.current?.api.applyTransaction({ remove: ids.map((__id) => ({ __id })) }); setSelected(0); }
    catch (err) { setError(`Could not delete: ${err.message}`); }
  }
  async function addColumn(e) {
    e.preventDefault();
    if (!newCol.name.trim()) return;
    const options = newCol.type === 'select' ? newCol.options.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const pos = Math.max(-1, ...(cols || []).map((c) => c.position)) + 1;
    try { await api('/table_columns', { method: 'POST', body: { table_id: item.id, name: newCol.name.trim(), type: newCol.type, options, position: pos }, prefer: 'return=minimal' }); setNewCol({ name: '', type: 'text', options: '' }); loadCols(); }
    catch (err) { setError(`Could not add the column: ${err.message}`); }
  }
  async function renameColumn(c, name) {
    if (!name.trim() || name.trim() === c.name) return;
    try { await api(`/table_columns?id=eq.${c.id}`, { method: 'PATCH', body: { name: name.trim() }, prefer: 'return=minimal' }); loadCols(); } catch (err) { setError(`Could not rename: ${err.message}`); }
  }
  async function removeColumn(c) {
    if (!window.confirm(`Remove the column "${c.name}"? Its values disappear for everyone.`)) return;
    try { await api(`/table_columns?id=eq.${c.id}`, { method: 'DELETE', prefer: 'return=minimal' }); loadCols(); } catch (err) { setError(`Could not remove: ${err.message}`); }
  }

  if (!cols || !rows) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the table"><span /><span /><span /></div>;
  return (
    <div className="tbl">
      {editable && (
        <div className="tbl-bar">
          <button className="btn btn--primary btn--sm" onClick={addRow}>Add row</button>
          <button className="btn btn--sm" onClick={deleteSelected} disabled={!selected}>Delete selected{selected ? ` (${selected})` : ''}</button>
          <button className="btn btn--sm" onClick={() => setManage((m) => !m)} aria-expanded={manage}>Columns</button>
        </div>
      )}
      {error && <p className="send-error" role="alert">{error}</p>}
      {manage && editable && (
        <section className="tbl-cols" aria-label="Columns">
          <ul>
            {cols.map((c) => (
              <li key={c.id} className="pair">
                <label className="visually-hidden" htmlFor={`col-${c.id}`}>Column name</label>
                <input id={`col-${c.id}`} defaultValue={c.name} onBlur={(e) => renameColumn(c, e.target.value)} />
                <span className="tbl-type">{TYPES[c.type]}</span>
                <button className="btn btn--sm" onClick={() => removeColumn(c)}>Remove</button>
              </li>
            ))}
          </ul>
          <form className="pair" onSubmit={addColumn} aria-label="Add a column">
            <label className="visually-hidden" htmlFor="newcol-name">New column name</label>
            <input id="newcol-name" placeholder="New column" value={newCol.name} onChange={(e) => setNewCol({ ...newCol, name: e.target.value })} />
            <label className="visually-hidden" htmlFor="newcol-type">Type</label>
            <select id="newcol-type" value={newCol.type} onChange={(e) => setNewCol({ ...newCol, type: e.target.value })}>
              {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {newCol.type === 'select' && (<><label className="visually-hidden" htmlFor="newcol-opts">Choices</label>
              <input id="newcol-opts" placeholder="Choices, comma separated" value={newCol.options} onChange={(e) => setNewCol({ ...newCol, options: e.target.value })} /></>)}
            <button className="btn btn--sm" type="submit" disabled={!newCol.name.trim()}>Add column</button>
          </form>
        </section>
      )}
      <div className="tbl-grid">
        <AgGridReact
          ref={grid}
          theme={theme}
          rowData={rows}
          columnDefs={columnDefs}
          getRowId={(p) => p.data.__id}
          rowSelection={editable ? { mode: 'multiRow', checkboxes: true, headerCheckbox: true } : undefined}
          onSelectionChanged={(e) => setSelected(e.api.getSelectedRows().length)}
          onCellValueChanged={onCellValueChanged}
          stopEditingWhenCellsLoseFocus
          singleClickEdit={editable}
          overlayNoRowsTemplate={editable ? 'No rows yet. Use Add row.' : 'No rows yet.'}
        />
      </div>
    </div>
  );
}
