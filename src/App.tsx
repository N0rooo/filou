import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import logo from './assets/filou.svg'
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
  const [reglages, setReglages] = useState(false)
  const [iaProgres, setIaProgres] = useState<{ fait: number; total: number } | null>(null)
  const [iaDebut, setIaDebut] = useState<number | null>(null)
  const [, setTic] = useState(0)
  // Décompte façon Médor : projection figée à chaque lot terminé (marge 1.35,
  // les lots parallèles finissent par les plus lents), vrai compte à rebours
  // entre deux — le chiffre ne remonte jamais tout seul.
  const etapePrec = useRef(-1)
  const estimeRestant = useRef(0)
  const dateEstime = useRef(Date.now())
  const [etatIa, setEtatIa] = useState<{ cli: string | null; cle: boolean } | undefined>(undefined)
  const [cleSaisie, setCleSaisie] = useState('')
  const [modele, setModele] = useState(() => localStorage.getItem('filouModele') ?? 'haiku')
  const [consignes, setConsignes] = useState(() => localStorage.getItem('filouConsignes') ?? '')
  const [detail, setDetail] = useState(() => localStorage.getItem('filouDetail') ?? 'equilibre')
  // Onboarding : trois étapes au tout premier lancement, puis plus jamais.
  const [etape, setEtape] = useState<number | null>(() =>
    localStorage.getItem('filouOnboarde') ? null : 0,
  )

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
    invoke<{ cli: string | null; cle: boolean }>('etat_ia').then(setEtatIa)
    const abo = listen<{ fait: number; total: number }>('ia-progres', (e) => setIaProgres(e.payload))
    // Un tic par seconde pour rafraîchir le temps écoulé/restant affiché.
    const tic = setInterval(() => setTic((t) => t + 1), 1000)
    return () => {
      abo.then((desabo) => desabo())
      clearInterval(tic)
    }
  }, [])

  const changerModele = (m: string) => {
    setModele(m)
    localStorage.setItem('filouModele', m)
  }

  const changerConsignes = (c: string) => {
    setConsignes(c)
    localStorage.setItem('filouConsignes', c)
  }

  const finirOnboarding = () => {
    localStorage.setItem('filouOnboarde', 'oui')
    setEtape(null)
  }

  const changerDetail = (d: string) => {
    setDetail(d)
    localStorage.setItem('filouDetail', d)
  }

  // Regroupement par (zone, racine) : « Projets/Filou/Logos » compte dans la
  // racine « Projets », le reste du chemin s'affiche en sous-groupe dedans.
  const groupes = useMemo(() => {
    if (!zones) return []
    return zones.map((z) => {
      const parRacine = new Map<string, Fiche[]>()
      for (const f of z.fichiers) {
        const racine = f.categorie.split('/')[0]
        const liste = parRacine.get(racine) ?? []
        liste.push(f)
        parRacine.set(racine, liste)
      }
      const categories = [...parRacine.entries()].sort((a, b) => b[1].length - a[1].length)
      return { zone: z, categories }
    })
  }, [zones])

  const sousGroupes = (fiches: Fiche[]) => {
    const m = new Map<string, Fiche[]>()
    for (const f of fiches) {
      const i = f.categorie.indexOf('/')
      const reste = i === -1 ? '' : f.categorie.slice(i + 1)
      const liste = m.get(reste) ?? []
      liste.push(f)
      m.set(reste, liste)
    }
    return [...m.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : b[1].length - a[1].length))
  }

  const cle = (zone: string, categorie: string) => `${zone}|${categorie}`
  const retenues = useMemo(() => {
    const liste: { chemin: string; dossier: string }[] = []
    for (const g of groupes)
      for (const [racine, fiches] of g.categories)
        if (!decoches.has(cle(g.zone.nom, racine)))
          for (const f of fiches) liste.push({ chemin: f.chemin, dossier: f.categorie })
    return liste
  }, [groupes, decoches])

  const totalVrac = zones?.reduce((n, z) => n + z.fichiers.length, 0) ?? 0

  const affinerIa = async () => {
    if (!zones) return
    setStatut("Filou réfléchit avec l'IA…")
    setIaProgres(null)
    setIaDebut(Date.now())
    etapePrec.current = -1
    estimeRestant.current = 0
    setErreur(null)
    try {
      const noms = zones.flatMap((z) => z.fichiers.map((f) => f.nom))
      const table = await invoke<Record<string, string>>('plan_ia', { fichiers: noms, modele, consignes, detail })
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
      setIaDebut(null)
      setIaProgres(null)
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

  const enregistrerCle = async (cle: string) => {
    try {
      await invoke<boolean>('definir_cle_api', { cle })
      setCleSaisie('')
      setEtatIa(await invoke<{ cli: string | null; cle: boolean }>('etat_ia'))
    } catch (e) {
      setErreur(String(e))
    }
  }

  // Projection figée : recalculée uniquement quand un lot de plus est terminé.
  if (iaDebut && iaProgres && iaProgres.fait > 0 && iaProgres.fait !== etapePrec.current) {
    etapePrec.current = iaProgres.fait
    dateEstime.current = Date.now()
    estimeRestant.current =
      (((Date.now() - iaDebut) / 1000) * (iaProgres.total - iaProgres.fait) * 1.35) / iaProgres.fait
  }

  const resumeConfirmation = useMemo(() => {
    const parDossier = new Map<string, number>()
    for (const r of retenues) parDossier.set(r.dossier, (parDossier.get(r.dossier) ?? 0) + 1)
    return [...parDossier.entries()].sort((a, b) => b[1] - a[1])
  }, [retenues])

  const blocIa = (
    <>
      {etatIa === undefined && <p className="gris">Recherche de Claude Code…</p>}
      {etatIa && etatIa.cle && (
        <p className="gris">
          Clé API enregistrée dans le trousseau : l'affinage passe directement par l'API Anthropic
          (plus rapide que le CLI). Seuls les noms de fichiers sont envoyés, jamais leur contenu.{' '}
          <button className="petit-bouton" onClick={() => enregistrerCle('')}>
            Retirer la clé
          </button>
        </p>
      )}
      {etatIa && !etatIa.cle && etatIa.cli && (
        <p className="gris">
          Claude Code détecté (<span className="mono">{etatIa.cli}</span>) : ça marchera tout seul
          avec ton abonnement Claude. Tu peux aussi mettre une clé API, c'est plus rapide.
        </p>
      )}
      {etatIa && !etatIa.cle && !etatIa.cli && (
        <p className="gris">
          Claude Code est introuvable sur cette machine. Ajoute une clé API Anthropic ci-dessous, ou
          installe Claude Code (claude.com/claude-code).
        </p>
      )}
      {etatIa && !etatIa.cle && (
        <div className="ligne-reglage">
          <input
            type="password"
            placeholder="Clé API Anthropic (sk-ant-…)"
            value={cleSaisie}
            onChange={(e) => setCleSaisie(e.target.value)}
          />
          <button
            className="petit-bouton"
            disabled={!cleSaisie.trim()}
            onClick={() => enregistrerCle(cleSaisie)}
          >
            Enregistrer
          </button>
        </div>
      )}
      <label className="ligne-reglage">
        Modèle pour l'affinage
        <select value={modele} onChange={(e) => changerModele(e.target.value)}>
          <option value="haiku">Rapide (Haiku)</option>
          <option value="sonnet">Équilibré (Sonnet)</option>
          <option value="opus">Malin mais lent (Opus)</option>
          <option value="">Réglage par défaut du CLI</option>
        </select>
      </label>
    </>
  )

  const blocMethode = (
    <>
      <textarea
        className="consignes"
        rows={4}
        placeholder="Tes consignes de rangement… (ex. : les factures par année, un dossier par projet, les captures d'écran par mois)"
        value={consignes}
        onChange={(e) => changerConsignes(e.target.value)}
      />
      <label className="ligne-reglage">
        Niveau de détail de l'arborescence
        <select value={detail} onChange={(e) => changerDetail(e.target.value)}>
          <option value="simple">Simple : des racines, pas de sous-dossiers</option>
          <option value="equilibre">Équilibré : un sous-dossier quand utile</option>
          <option value="maniaque">Maniaque : sous-dossiers stricts partout</option>
        </select>
      </label>
    </>
  )

  return (
    <div className="page">
      <div className="contenu">
        <header>
          <img className="logo" src={logo} alt="" />
          <h1>Filou</h1>
          <span className="tagline">il range tes fichiers, l'air de rien</span>
          <button className="petit-bouton coin" onClick={() => setReglages(true)}>
            Réglages
          </button>
        </header>

        {statut && (
          <div className="statut">
            {(() => {
              if (!iaDebut) return statut
              const duree = (s: number) =>
                s >= 60
                  ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`
                  : `${Math.max(1, Math.round(s))} s`
              if (iaProgres && iaProgres.total > 0 && iaProgres.fait >= iaProgres.total)
                return 'Filou termine…'
              if (iaProgres && iaProgres.fait > 0) {
                const decompte = Math.round(
                  estimeRestant.current - (Date.now() - dateEstime.current) / 1000,
                )
                const fin = decompte > 3 ? `≈ ${duree(decompte)} restantes` : 'encore un peu…'
                return `Filou réfléchit… lot ${iaProgres.fait}/${iaProgres.total} terminé, ${fin}`
              }
              const lots = iaProgres?.total
              const ecoule = (Date.now() - iaDebut) / 1000
              return `Filou réfléchit${lots ? ` (${lots} lot${lots > 1 ? 's' : ''} à traiter)` : ''}… ${duree(ecoule)} écoulées`
            })()}
            {iaDebut && iaProgres && iaProgres.total > 0 && (
              <div className="jauge">
                <div style={{ width: `${Math.max(4, (iaProgres.fait / iaProgres.total) * 100)}%` }} />
              </div>
            )}
          </div>
        )}
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
            <p>Pas un fichier qui traîne sur le Bureau ni dans les Téléchargements. Filou fait le fier.</p>
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
                      <div className="detail-groupe">
                        {sousGroupes(fiches).map(([chemin, liste]) => (
                          <div key={chemin || '(racine)'}>
                            {chemin !== '' && (
                              <div className="sous-chemin">
                                {chemin}
                                <span className="mono compte">{liste.length}</span>
                              </div>
                            )}
                            <ul className="fichiers">
                              {liste.map((f) => (
                                <li key={f.chemin}>
                                  <span className="nom">{f.nom}</span>
                                  <span className="mono meta">
                                    {octets(f.taille)} · {dateFr(f.modifie)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
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

      {etape !== null && (
        <div className="voile">
          <div className="modale onboarding">
            {etape === 0 && (
              <div className="accueil-onboarding">
                <img src={logo} alt="" />
                <h2>Salut, moi c'est Filou.</h2>
                <p className="gris">
                  Je range les fichiers qui traînent sur ton Bureau et dans tes Téléchargements :
                  j'analyse, je te propose un plan de dossiers, tu décoches ce que tu veux laisser
                  tranquille, et je range. Tout est annulable depuis le journal, et rien ne quitte
                  ta machine sans toi.
                </p>
              </div>
            )}
            {etape === 1 && (
              <>
                <h2>Connecte ton IA</h2>
                <p className="gris">
                  Pour un plan malin (projets reconnus, factures par année…), Filou demande à
                  Claude. Seuls les noms de fichiers sont envoyés, jamais leur contenu.
                </p>
                {blocIa}
              </>
            )}
            {etape === 2 && (
              <>
                <h2>Ta façon de ranger</h2>
                <p className="gris">
                  Dis-moi tes habitudes, j'en tiendrai compte à chaque plan. Tu pourras changer
                  tout ça plus tard dans les Réglages.
                </p>
                {blocMethode}
              </>
            )}
            <div className="actions">
              {etape > 0 && (
                <button className="petit-bouton" onClick={() => setEtape(etape - 1)}>
                  Retour
                </button>
              )}
              {etape < 2 ? (
                <button className="gros-bouton" onClick={() => setEtape(etape + 1)}>
                  Continuer
                </button>
              ) : (
                <button className="gros-bouton" onClick={finirOnboarding}>
                  C'est parti
                </button>
              )}
              {etape === 0 && (
                <button className="petit-bouton" onClick={finirOnboarding}>
                  Passer
                </button>
              )}
            </div>
            <div className="points">
              {[0, 1, 2].map((i) => (
                <span key={i} className={i === etape ? 'actif' : ''} />
              ))}
            </div>
          </div>
        </div>
      )}

      {reglages && (
        <div className="voile" onClick={() => setReglages(false)}>
          <div className="modale" onClick={(e) => e.stopPropagation()}>
            <h2>Réglages</h2>
            <h3>Intelligence artificielle</h3>
            {blocIa}
            <h3>Ta méthode de rangement</h3>
            <p className="gris">
              Explique à Filou comment tu ranges, il en tiendra compte à chaque affinage par l'IA.
            </p>
            {blocMethode}
            <div className="actions">
              <button className="gros-bouton" onClick={() => setReglages(false)}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

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
