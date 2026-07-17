import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, StatusBar, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {scaleTextStyles} from '@utils/scaling';
import {newsApi} from '@services/api';

type Filter = 'ALL' | 'UAE' | 'KSA' | 'UK' | 'GLOBAL' | 'TECH';

const FILTERS: Filter[] = ['ALL','UAE','KSA','UK','GLOBAL','TECH'];

interface Article {
  id: string;
  featured: boolean;
  cat: string; catColor: string; region: string; regionColor: string;
  icon: string; iconColor: string;
  title: string; summary: string;
  source: string; time: string; readTime: string; filter: string;
}

const CAT_ICON: Record<string, {icon: string; color: string}> = {
  security:    {icon: 'shield-alert', color: '#7F1D1D'},
  finance:     {icon: 'bank',         color: '#374151'},
  technology:  {icon: 'laptop',       color: '#164E63'},
  development: {icon: 'hammer',        color: '#374151'},
  'real estate': {icon: 'city',       color: '#1D4ED8'},
};

function relativeTime(iso?: string): string {
  if (!iso) {return '';}
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) {return '';}
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) {return 'just now';}
  if (h < 24) {return `${h} hr${h > 1 ? 's' : ''} ago`;}
  return `${Math.floor(h / 24)}d ago`;
}

// Map an untyped /news/feed row into the card shape this screen renders,
// with sensible defaults when the backend omits presentation fields.
function toArticle(r: Record<string, unknown>, i: number): Article {
  const cat = String(r.category ?? r.cat ?? 'News');
  const region = String(r.region ?? 'GLOBAL').toUpperCase();
  const ci = CAT_ICON[cat.toLowerCase()] ?? {icon: 'newspaper-variant', color: '#374151'};
  return {
    id: String(r.id ?? `n${i}`),
    featured: i === 0,
    cat, catColor: '#2563EB', region, regionColor: '#60A5FA',
    icon: ci.icon, iconColor: ci.color,
    title: String(r.title ?? 'Untitled'),
    summary: String(r.summary ?? r.excerpt ?? ''),
    source: String(r.source ?? 'Bravo News'),
    time: relativeTime(typeof r.published_at === 'string' ? r.published_at : (r.created_at as string | undefined)),
    readTime: String(r.read_time ?? '3 min read'),
    filter: region,
  };
}

export default function NewsFeedScreen() {
  const insets = useSafeAreaInsets();
  // B-98b G1 — pushed from both NewsNavigator and MessengerNavigator with no
  // visible way back (header only had filter/RSS); goBack pops to the pusher.
  const navigation = useNavigation<{goBack: () => void}>();
  const [filter, setFilter] = useState<Filter>('ALL');
  const [breakingVisible, setBreakingVisible] = useState(true);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const {data} = await newsApi.getFeed();
      const rows: Record<string, unknown>[] = Array.isArray(data)
        ? data
        : Array.isArray((data as {articles?: unknown[]})?.articles)
          ? (data as {articles: Record<string, unknown>[]}).articles
          : [];
      setArticles(rows.map(toArticle));
    } catch {
      setArticles([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = filter === 'ALL' ? articles : articles.filter(a => a.filter === filter);
  const [featured, ...rest] = visible;

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBtn}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => navigation.goBack()}>
          <Icon name="chevron-left" size={22} color="#94A3B8" />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0, marginLeft: 10}}>
          <Text style={styles.headerSub}>Bravo News Channel</Text>
          <View style={styles.headerTitleRow}>
            <Text style={styles.headerTitle}>Regional News Feed</Text>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveBadgeText}>LIVE</Text>
            </View>
          </View>
        </View>
        <View style={styles.headerBtns}>
          <TouchableOpacity style={styles.headerBtn} activeOpacity={0.7}>
            <Icon name="filter-variant" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn} activeOpacity={0.7}>
            <Icon name="rss" size={20} color="#94A3B8" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Breaking ticker */}
      {breakingVisible && (
        <View style={styles.breakingWrap}>
          <View style={styles.breakingInner}>
            <View style={styles.breakingBadge}>
              <Text style={styles.breakingBadgeText}>Breaking</Text>
            </View>
            <Text style={styles.breakingText} numberOfLines={1}>
              UAE Central Bank raises key rate 250bps — statement released...
            </Text>
            <TouchableOpacity style={styles.breakingRead} activeOpacity={0.7}>
              <Text style={styles.breakingReadText}>Read →</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setBreakingVisible(false)} activeOpacity={0.7}>
              <Icon name="close" size={16} color="#475569" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        style={styles.filterScroll} contentContainerStyle={styles.filterContent}>
        {FILTERS.map(f => (
          <TouchableOpacity key={f}
            style={[styles.chip, filter === f && styles.chipActive]}
            onPress={() => setFilter(f)} activeOpacity={0.7}>
            <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Feed */}
      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 88}]}>

        {loading && (
          <View style={{paddingVertical: 48, alignItems: 'center'}}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        )}
        {!loading && visible.length === 0 && (
          <View style={{paddingVertical: 48, alignItems: 'center', gap: 8, paddingHorizontal: 32}}>
            <Icon name="newspaper-variant-outline" size={34} color="#334155" />
            <Text style={{fontSize: 15, fontWeight: '700', color: '#F1F5F9'}}>No news yet</Text>
            <Text style={{fontSize: 12.5, color: '#64748B', textAlign: 'center'}}>Check back soon for regional updates.</Text>
          </View>
        )}

        {/* Featured hero card */}
        {featured && (
          <TouchableOpacity style={styles.heroCard} activeOpacity={0.9}>
            {/* Image area */}
            <View style={styles.heroImg}>
              <Icon name={featured.icon} size={80} color={featured.iconColor} style={styles.heroImgIcon} />
              <View style={styles.heroImgOverlay} />
              <View style={styles.heroBadges}>
                <View style={[styles.catBadge, {backgroundColor: featured.catColor + 'DD'}]}>
                  <Text style={styles.catBadgeText}>{featured.cat.toUpperCase()}</Text>
                </View>
                <View style={[styles.catBadge, {backgroundColor:'rgba(34,197,94,0.85)'}]}>
                  <Text style={styles.catBadgeText}>FEATURED</Text>
                </View>
              </View>
            </View>
            <View style={styles.heroBody}>
              <Text style={styles.heroTitle}>{featured.title}</Text>
              <View style={styles.heroMeta}>
                <Text style={styles.heroMetaText}>
                  <Text style={styles.heroSource}>{featured.source}</Text>
                  {' · '}{featured.time}{' · '}{featured.readTime}
                </Text>
              </View>
              <Text style={styles.heroSummary} numberOfLines={2}>{featured.summary}</Text>
              <View style={styles.readBtn}>
                <Text style={styles.readBtnText}>READ →</Text>
              </View>
            </View>
          </TouchableOpacity>
        )}

        {/* Article list */}
        {rest.map(article => (
          <TouchableOpacity key={article.id} style={styles.articleCard} activeOpacity={0.9}>
            <View style={[styles.articleThumb, {backgroundColor: article.iconColor + '30'}]}>
              <Icon name={article.icon} size={34} color={article.iconColor + '80'} />
              <View style={[styles.regionBadge, {backgroundColor: article.catColor + 'E0'}]}>
                <Text style={styles.regionBadgeText}>{article.region}</Text>
              </View>
            </View>
            <View style={styles.articleInfo}>
              <Text style={[styles.articleCat, {color: article.regionColor}]}>
                {article.cat} · {article.time}
              </Text>
              <Text style={styles.articleTitle} numberOfLines={2}>{article.title}</Text>
              <View style={styles.articleMeta}>
                <Text style={styles.articleSource}>{article.source}</Text>
                <Text style={styles.articleTime}> · {article.time}</Text>
              </View>
            </View>
            <View style={styles.articleActions}>
              <TouchableOpacity activeOpacity={0.7}>
                <Icon name="bookmark-outline" size={15} color="#475569" />
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.7}>
                <Icon name="share-variant-outline" size={15} color="#475569" />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},

  header: {flexDirection:'row', alignItems:'flex-start', justifyContent:'space-between', paddingHorizontal:16, paddingTop:6, paddingBottom:10, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  headerSub: {color:'#475569', fontSize:9, fontWeight:'800', letterSpacing:3, textTransform:'uppercase', marginBottom:2},
  headerTitleRow: {flexDirection:'row', alignItems:'center', gap:8},
  headerTitle: {color:'#F1F5F9', fontSize:17, fontWeight:'800'},
  liveBadge: {flexDirection:'row', alignItems:'center', gap:4, paddingHorizontal:8, paddingVertical:3, borderRadius:99, backgroundColor:'rgba(34,197,94,0.12)', borderWidth:1, borderColor:'rgba(34,197,94,0.3)'},
  liveDot: {width:6, height:6, borderRadius:3, backgroundColor:'#22C55E'},
  liveBadgeText: {color:'#4ade80', fontSize:9, fontWeight:'800', letterSpacing:0.5},
  headerBtns: {flexDirection:'row', gap:4, marginTop:4},
  headerBtn: {width:36, height:36, borderRadius:18, alignItems:'center', justifyContent:'center'},

  breakingWrap: {paddingHorizontal:12, paddingVertical:8},
  breakingInner: {flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:12, paddingVertical:10, borderRadius:12, backgroundColor:'rgba(220,38,38,0.08)', borderWidth:1, borderColor:'rgba(220,38,38,0.2)', borderLeftWidth:3, borderLeftColor:'#DC2626'},
  breakingBadge: {backgroundColor:'#DC2626', borderRadius:4, paddingHorizontal:6, paddingVertical:2, flexShrink:0},
  breakingBadgeText: {color:'#FFF', fontSize:9, fontWeight:'800', letterSpacing:0.5, textTransform:'uppercase'},
  breakingText: {flex:1, color:'#E2E8F0', fontSize:12, fontWeight:'600'},
  breakingRead: {flexShrink:0},
  breakingReadText: {color:'#60A5FA', fontSize:12, fontWeight:'700'},

  filterScroll: {flexGrow:0},
  filterContent: {paddingHorizontal:12, paddingBottom:10, gap:8},
  chip: {paddingHorizontal:14, paddingVertical:5, borderRadius:99, borderWidth:1.5, borderColor:'#1E2D45'},
  chipActive: {backgroundColor:'rgba(37,99,235,0.15)', borderColor:Colors.primary},
  chipText: {color:'#64748B', fontSize:12, fontWeight:'700'},
  chipTextActive: {color:'#60A5FA'},

  content: {paddingHorizontal:12, paddingTop:4, gap:12},

  heroCard: {backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', borderRadius:16, overflow:'hidden'},
  heroImg: {height:180, backgroundColor:'#0D2240', alignItems:'center', justifyContent:'center', position:'relative'},
  heroImgIcon: {opacity:0.12},
  heroImgOverlay: {position:'absolute', bottom:0, left:0, right:0, height:90, backgroundColor:'transparent'},
  heroBadges: {position:'absolute', top:12, left:12, flexDirection:'row', gap:6},
  catBadge: {paddingHorizontal:6, paddingVertical:2, borderRadius:4},
  catBadgeText: {color:'#FFF', fontSize:8, fontWeight:'800', letterSpacing:0.6, textTransform:'uppercase'},
  heroBody: {padding:14},
  heroTitle: {color:'#F1F5F9', fontSize:16, fontWeight:'800', lineHeight:22, marginBottom:6},
  heroMeta: {marginBottom:6},
  heroMetaText: {color:'#64748B', fontSize:10},
  heroSource: {color:'#94A3B8', fontWeight:'700'},
  heroSummary: {color:'#94A3B8', fontSize:12, lineHeight:18, marginBottom:10},
  readBtn: {alignSelf:'flex-start', paddingHorizontal:12, paddingVertical:6, borderRadius:8, backgroundColor:'rgba(37,99,235,0.15)', borderWidth:1, borderColor:'rgba(37,99,235,0.3)'},
  readBtnText: {color:'#60A5FA', fontSize:10, fontWeight:'800', letterSpacing:0.5},

  articleCard: {flexDirection:'row', alignItems:'center', gap:12, backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', borderRadius:16, padding:10, height:96},
  articleThumb: {width:76, alignSelf:'stretch', borderRadius:12, alignItems:'center', justifyContent:'center', position:'relative', flexShrink:0},
  regionBadge: {position:'absolute', bottom:4, left:4, paddingHorizontal:4, paddingVertical:2, borderRadius:4},
  regionBadgeText: {color:'#FFF', fontSize:8, fontWeight:'800', letterSpacing:0.5},
  articleInfo: {flex:1, justifyContent:'center'},
  articleCat: {fontSize:10, fontWeight:'700', textTransform:'uppercase', letterSpacing:0.5, marginBottom:4},
  articleTitle: {color:'#F1F5F9', fontSize:13, fontWeight:'700', lineHeight:18},
  articleMeta: {flexDirection:'row', marginTop:4},
  articleSource: {color:'#94A3B8', fontSize:10, fontWeight:'600'},
  articleTime: {color:'#475569', fontSize:10},
  articleActions: {gap:10, flexShrink:0},
}));
