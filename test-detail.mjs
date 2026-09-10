// 模拟 fetchVideoDetailData 的选源逻辑，检查各源用户实际拿到的剧集 URL 形态
import axios from 'axios';

const API_SITES = {
    ffzy: 'http://ffzy5.tv',
    zy360: 'https://360zy.com',
    wolong: 'https://wolongzyw.com',
    jisu: 'https://jszyapi.com',
    dbzy: 'https://dbzy.com',
    bfzy: 'https://bfzyapi.com',
    mdzy: 'https://www.mdzyapi.com',
    ruyi: 'https://cj.rycjapi.com',
    zuid: 'https://api.zuidapi.com',
};

for (const [id, api] of Object.entries(API_SITES)) {
    try {
        // 1) 搜索拿 vod_id（与前端一致：ac=videolist&wd=）
        const s = await axios.get(`${api}/api.php/provide/vod/?ac=videolist&wd=%E5%86%8D%E8%A7%81%E7%88%B1%E4%BA%BA`, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const v = (s.data.list || []).find(x => (x.vod_play_url || '').includes('m3u8')) || (s.data.list || [])[0];
        if (!v) { console.log(`[${id}] 搜索无结果`); continue; }
        // 2) 详情（与前端一致：ac=videolist&ids=）
        const d = await axios.get(`${api}/api.php/provide/vod/?ac=videolist&ids=${v.vod_id}`, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const vd = (d.data.list || [])[0];
        if (!vd || !vd.vod_play_url) { console.log(`[${id}] 详情无数据`); continue; }
        // 3) 与前端 extractEps/选源逻辑完全一致
        const extractEps = src => src.split('#').map(ep => {
            const parts = ep.split('$');
            return parts.length > 1 ? parts[1] : '';
        }).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
        let episodes = [];
        const playSources = vd.vod_play_url.split('$$$');
        const srcNames = (vd.vod_play_from || '').split('$$$');
        for (const src of playSources) {
            const eps = extractEps(src);
            if (eps.length === 0) continue;
            if (eps.some(u => /\.m3u8([?#]|$)/i.test(u))) { episodes = eps; break; }
            if (episodes.length === 0) episodes = eps;
        }
        const m3u8Count = episodes.filter(u => /\.m3u8([?#]|$)/i.test(u)).length;
        console.log(`[${id}] ${vd.vod_name} | 播放源: ${srcNames.join(',')} | 选中集数: ${episodes.length} | 其中m3u8: ${m3u8Count}`);
        console.log(`   ep1: ${episodes[0]}`);
        console.log(`   -> 时长检测走: ${/\.m3u8([?#]|$)/i.test(episodes[0] || '') ? 'fetchM3u8Duration' : 'fetchMediaDurationByVideo(裸URL直连, 不走代理!)'}`);
    } catch (e) {
        console.log(`[${id}] 异常: ${e.code || e.message.slice(0, 60)}`);
    }
}
process.exit(0);
