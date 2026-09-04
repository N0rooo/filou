import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './styles.css'

type Fiche = { nom: string; chemin: string; taille: number; modifie: number; categorie: string }
type Zone = { nom: string; chemin: string; fichiers: Fiche[] }
type Bilan = { ranges: number; erreurs: string[]; lignes: string[] }
type Entree = { ts: number; resume: string; lignes: string[]; deplacements: [string, string][] }

const octets = (n: number) => {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} Go`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} Mo`
  if (n >= 1_000) return `${Math.round(n / 1_000)} Ko`
  return `${n} o`
}
const dateFr = (ts: number) =>
  new Date(ts * 1000).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function App() {
  const [zones, setZones] = useState<Zone[] | null>(null)
  const [statut, setStatut] = useState<string | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [decoches, setDecoches] = useState<Set<string>>(new Set())
  const [bilan, setBilan] = useState<Bilan | null>(null)
  const [journal, setJournal] = useState<Entree[]>([])
  const [confirmation, setConfirmation] = useState(false)
  const [iaNote, setIaNote] = useState<string | null>(null)

  const analyser = async () => {
    setStatut('Filou renifle le Bureau et les Téléchargements…')
    setErreur(null)
    setIaNote(null)
    try {
      setZones(await invoke<Zone[]>('inventaire'))
      setDecoches(new Set())
    } catch (e) {
      setErreur(String(e))
    } finally {
      setStatut(null)
    }
  }

  const chargerJournal = async () => {
    try {
      setJournal(await invoke<Entree[]>('journal_liste'))
    } catch {
      /* le journal absent au premier lancement n'est pas une erreur */
    }
  }

  useEffect(() => {
    analyser()
    chargerJournal()
  }, [])

  // Regroupement par (zone, catégorie), l'ordre suit le volume.
  const groupes = useMemo(() => {
    if (!zones) return []
    return zones.map((z) => {
      const parCategorie = new Map<string, Fiche[]>()
      for (const f of z.fichiers) {
        const liste = parCategorie.get(f.categorie) ?? []
        liste.push(f)
        parCategorie.set(f.categorie, liste)
      }
      const categories = [...parCategorie.entries()].sort((a, b) => b[1].length - a[1].length)
      return { zone: z, categories }
    })
  }, [zones])

  const cle = (zone: string, categorie: string) => `${zone}|${categorie}`
  const retenues = useMemo(() => {
    const liste: { chemin: string; dossier: string }[] = []
    for (const g of groupes)
      for (const [categorie, fiches] of g.categories)
        if (!decoches.has(cle(g.zone.nom, categorie)))
          for (const f of fiches) liste.push({ chemin: f.chemin, dossier: categorie })
    return liste
  }, [groupes, decoches])

  const totalVrac = zones?.reduce((n, z) => n + z.fichiers.length, 0) ?? 0

  const affinerIa = async () => {
    if (!zones) return
    setStatut("Filou réfléchit avec l'IA (jusqu'à quelques minutes)…")
    setErreur(null)
    try {
      const noms = zones.flatMap((z) => z.fichiers.map((f) => f.nom))
      const table = await invoke<Record<string, string>>('plan_ia', { fichiers: noms })
      let changes = 0
      setZones((zs) =>
        zs
          ? zs.map((z) => ({
              ...z,
              fichiers: z.fichiers.map((f) => {
                const propose = table[f.nom]
                if (propose && propose !== f.categorie) {
                  changes += 1
                  return { ...f, categorie: propose }
                }
                return f
              }),
            }))
          : zs,
      )
      setIaNote(
        changes > 0
          ? `L'IA a affiné le plan : ${changes} fichier${changes > 1 ? 's' : ''} reclassé${changes > 1 ? 's' : ''}.`
          : "L'IA est d'accord avec le plan actuel.",
      )
      setDecoches(new Set())
    } catch (e) {
      setErreur(String(e))
    } finally {
      setStatut(null)
    }
  }

  const ranger = async () => {
    setConfirmation(false)
    setStatut(`Filou range ${retenues.length} fichiers…`)
    setErreur(null)
    try {
      const b = await invoke<Bilan>('ranger', { deplacements: retenues })
      setBilan(b)
      await analyser()
      await chargerJournal()
    } catch (e) {
      setErreur(String(e))
    } finally {
      setStatut(null)
    }
  }

  const annuler = async () => {
    setStatut('Filou remet tout à sa place…')
    setErreur(null)
    try {
      await invoke<number>('annuler')
      setBilan(null)
      await analyser()
      await chargerJournal()
    } catch (e) {
      setErreur(String(e))
    } finally {
      setStatut(null)
    }
  }

  const resumeConfirmation = useMemo(() => {
    const parDossier = new Map<string, number>()
    for (const r of retenues) parDossier.set(r.dossier, (parDossier.get(r.dossier) ?? 0) + 1)
    return [...parDossier.entries()].sort((a, b) => b[1] - a[1])
  }, [retenues])

  return (
    <div className="page">
      <div className="liseret" />
      <div className="contenu">
        <header>
          <h1>Filou</h1>
          <span className="tagline">le chien qui range tes fichiers</span>
        </header>

        {statut && <div className="statut">{statut}</div>}
        {erreur && <div className="erreur">{erreur}</div>}
        {iaNote && <div className="note">{iaNote}</div>}

        {bilan && (
          <section className="carte bilan">
            <h2>
              {bilan.ranges} fichier{bilan.ranges > 1 ? 's' : ''} rangé{bilan.ranges > 1 ? 's' : ''}
            </h2>
            <ul>
              {bilan.lignes.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            {bilan.erreurs.length > 0 && (
              <details>
                <summary>{bilan.erreurs.length} fichier(s) non déplacé(s)</summary>
                <ul>
                  {bilan.erreurs.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        {zones && totalVrac === 0 && !statut && (
          <section className="carte vide">
            <h2>Tout est rangé.</h2>
            <p>Aucun fichier en vrac sur le Bureau ni dans les Téléchargements. Bon chien.</p>
          </section>
        )}

        {zones && totalVrac > 0 && (
          <>
            <div className="actions">
              <button className="gros-bouton" onClick={() => setConfirmation(true)} disabled={!!statut || retenues.length === 0}>
                Ranger {retenues.length.toLocaleString('fr-FR')} fichier{retenues.length > 1 ? 's' : ''}
              </button>
              <button className="petit-bouton" onClick={affinerIa} disabled={!!statut}>
                Affiner le plan avec l'IA
              </button>
              <button className="petit-bouton" onClick={analyser} disabled={!!statut}>
                Réanalyser
              </button>
            </div>

            {groupes.map(({ zone, categories }) => (
              <section className="carte" key={zone.nom}>
                <h2>
                  {zone.nom}
                  <span className="mono compte">
                    {zone.fichiers.length.toLocaleString('fr-FR')} fichier{zone.fichiers.length > 1 ? 's' : ''} en vrac
                  </span>
                </h2>
                {categories.length === 0 && <p className="gris">Rien qui traîne ici.</p>}
                {categories.map(([categorie, fiches]) => {
                  const k = cle(zone.nom, categorie)
                  const cochee = !decoches.has(k)
                  return (
                    <details className="groupe" key={k}>
                      <summary>
                        <input
                          type="checkbox"
                          checked={cochee}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() =>
                            setDecoches((d) => {
                              const suivant = new Set(d)
                              if (suivant.has(k)) suivant.delete(k)
                              else suivant.add(k)
                              return suivant
                            })
                          }
                        />
                        <strong>{categorie}</strong>
                        <span className="mono compte">{fiches.length.toLocaleString('fr-FR')}</span>
                      </summary>
                      <ul className="fichiers">
                        {fiches.map((f) => (
                          <li key={f.chemin}>
                            <span className="nom">{f.nom}</span>
                            <span className="mono meta">
                              {octets(f.taille)} · {dateFr(f.modifie)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )
                })}
              </section>
            ))}
          </>
        )}

        {journal.length > 0 && (
          <section className="carte">
            <h2>Journal</h2>
            {journal.map((e, i) => (
              <div className="entree" key={e.ts + '-' + i}>
                <div className="ligne-entree">
                  <span className="mono meta">{dateFr(e.ts)}</span>
                  <span>{e.resume}</span>
                  {i === 0 && e.deplacements.length > 0 && (
                    <button className="petit-bouton" onClick={annuler} disabled={!!statut}>
                      Annuler ce rangement
                    </button>
                  )}
                </div>
                {e.lignes.length > 0 && (
                  <details>
                    <summary>Détail</summary>
                    <ul>
                      {e.lignes.map((l, j) => (
                        <li key={j}>{l}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </section>
        )}
      </div>

      {confirmation && (
        <div className="voile" onClick={() => setConfirmation(false)}>
          <div className="modale" onClick={(e) => e.stopPropagation()}>
            <h2>Ranger {retenues.length.toLocaleString('fr-FR')} fichiers ?</h2>
            <p className="gris">
              Filou crée ces dossiers dans le Bureau et les Téléchargements, puis y déplace les fichiers. Tout est
              annulable depuis le journal.
            </p>
            <ul>
              {resumeConfirmation.map(([dossier, n]) => (
                <li key={dossier}>
                  <strong>{dossier}</strong> <span className="mono compte">{n.toLocaleString('fr-FR')}</span>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button className="gros-bouton" onClick={ranger}>
                Ranger
              </button>
              <button className="petit-bouton" onClick={() => setConfirmation(false)}>
                Pas maintenant
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
